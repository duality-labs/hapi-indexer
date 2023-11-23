import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../logger';
import { getLastBlockHeight, waitForNextBlock } from '../sync';
import { getCompletedHeightAtTime } from '../storage/sqlite3/db/block/getHeight';
import {
  BlockRangeRequestQuery,
  getBlockRange,
} from '../storage/sqlite3/db/blockRangeUtils';
import {
  FlattenSingularItems,
  GetEndpointData,
  GetEndpointResponse,
  ServerPluginContext,
} from './types';
import {
  PaginatedRequestQuery,
  decodePagination,
} from '../storage/sqlite3/db/paginationUtils';

export default async function serverSentEventRequest<
  PluginContext,
  DataSets extends unknown[],
  Shape
>(
  request: Request,
  h: ResponseToolkit,
  {
    shape,
    getData,
    getPaginatedResponse,
    compressResponses,
  }: {
    shape: Shape;
    getData: GetEndpointData<PluginContext, DataSets>;
    getPaginatedResponse: GetEndpointResponse<DataSets, Shape>;
    compressResponses?: boolean;
  }
): Promise<void> {
  const {
    from_height: fromHeight = 0,
    to_height: toHeight = request.query['pagination.before']
      ? // note: this pagination limit translation of "before" -> "to_height"
        //       will not resolve future timestamp blocks correctly (as they
        //       do not exist yet), and will resolve the current block height
        // todo: a better way to track "getData() time" than height would allow
        //       a better condition check as to when to exit the response loop
        //       and allow a 'pagination.before' future timestamp to behave
        //       as expected and end when the time has passed (in block data)
        await getCompletedHeightAtTime(request.query['pagination.before'])
      : Number.POSITIVE_INFINITY,
  } = getBlockRange(request.query);

  const { req, res } = request.raw;
  // establish SSE content through headers
  res.setHeader('Content-Type', 'text/event-stream');
  if (request.info.cors.isOriginMatch && request.headers['origin']) {
    res.setHeader('Access-Control-Allow-Origin', request.headers['origin']);
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  // add shape data
  res.write(
    formatChunk({
      event: 'id shape',
      data: '"block_range.to_height:start-end/total_items"',
    })
  );
  res.write(
    formatChunk({
      event: 'data shape',
      data: JSON.stringify(shape),
    })
  );
  // add initial data frame (so next frame has a fromHeight context in ID)
  res.write(
    formatChunk({
      event: 'update',
      id: fromHeight,
    })
  );
  // fetch response
  const cachedStringify = (request.server.plugins as ServerPluginContext)
    .compressResponse?.getCachedValue;
  // and listen for new updates to send
  let { offset } = decodePagination(request.query);
  let lastHeight = fromHeight;
  let lastPage: FlattenSingularItems<DataSets> | undefined = undefined;
  let aborted = false;
  req.once('close', () => (aborted = true));
  // wait until we get new data (newer than known height header)
  while (!aborted) {
    // wait for next block
    try {
      const loopFromHeight = lastHeight;
      const loopToHeight = Math.min(toHeight, getLastBlockHeight());
      // get current data from last known height
      const query: PaginatedRequestQuery & BlockRangeRequestQuery = {
        // default to only a "first height page" of small chunks
        'pagination.limit': !lastHeight && !offset ? '100' : '10000',
        ...request.query,
        'pagination.count_total': 'true',
        // add explicit block height range for caching (generating cache ID)
        'block_range.from_height': loopFromHeight.toFixed(0),
        'block_range.to_height': loopToHeight.toFixed(0),
      };
      // get the liquidity data (but if we *will* wait for new data then skip)
      const data =
        lastHeight !== loopToHeight
          ? await getData(request.params, query, h.context)
          : null;
      if (aborted) break;
      const [height = loopToHeight] = data || [];
      // only respond able to and response is within the requested range
      if (res.writable && height <= toHeight) {
        do {
          const pageQuery = {
            ...query,
            'pagination.offset': offset.toFixed(0),
          };
          const response = data && getPaginatedResponse(data, pageQuery);
          const page = response?.data;
          // determine if a "heartbeat" (no update) frame should be sent
          if (
            // if no data is found
            ((page || []) as [][]).every((v) => !v?.length) ||
            // if the same update as previously is found do not send duplicate
            (lastPage && JSON.stringify(lastPage) === JSON.stringify(page))
          ) {
            res.write(
              // send event responses without data: as a "heartbeat" signal
              formatChunk({
                event: 'heartbeat',
                id: height,
              })
            );
            continue;
          }
          const pageSize =
            // calculate page size depending on the pagination being
            // of one list or multiple lists
            // todo: pagination could be generalized into two functions
            //       paginateSingleDataSet and paginateMultipleDataSets
            //       which could add pagination_meta fields here for these calcs
            (response?.pagination?.totals?.length ?? 0) > 1
              ? (page as unknown[][]).reduce(
                  (acc, page) => Math.max(acc, page.length),
                  0
                )
              : page?.length ?? 0;
          const nextOffset = offset + (pageSize ?? 0);
          const total = response?.pagination?.total ?? pageSize;
          res.write(
            // send event responses with or without data: "empty" updates are a
            // "heartbeat" signal
            formatChunk({
              event: 'update',
              id:
                offset > 0 || total > nextOffset
                  ? `${height}:${offset + 1}-${nextOffset}/${total}`
                  : height,
              data:
                // respond with possibly cached and compressed JSON string
                (compressResponses &&
                  (await cachedStringify?.(
                    `${request.url.pathname}?${new URLSearchParams(pageQuery)}`,
                    page
                  ))) ||
                JSON.stringify(page),
            })
          );
          // set last page for next data frame comparison
          lastPage = page;

          // calculate next offset or reset to 0
          offset =
            pageSize && response?.pagination?.next_key ? offset + pageSize : 0;
        } while (offset > 0);
      }
      // if we were asked to stop at a certain height: stop
      // but I don't know why someone would request that
      if (loopToHeight >= toHeight) {
        break;
      }
      // set new height only if greater than last height
      // (might be requesting a future fromHeight)
      if (height > lastHeight) {
        lastHeight = height;
      }
      // wait for next block
      await waitForNextBlock(Number.POSITIVE_INFINITY);
    } catch (err) {
      logger.error(`SSE update error: ${err}`);
      // send error event to user
      if (res.writable) {
        res.write(
          formatChunk({
            event: 'error',
            data: (err as Error)?.message ?? `${err}`,
          })
        );
      }
      // exit loop, likely getData has failed somehow
      break;
    }
  }
  // send an event to signify that the data is complete
  res.write(formatChunk({ event: 'end' }));
  // wait a tick to be sure that "end" in in the queue
  await new Promise<void>((resolve) =>
    setTimeout(() => {
      !res.destroyed && res.destroy();
      resolve();
    }, 0)
  );
  // if data needs to drain then wait for it to drain
  if (res.writableNeedDrain) {
    await new Promise<void>((resolve) => {
      // wait for drain
      res.once('drain', resolve);
      // wait for timeout
      setTimeout(() => {
        logger.error('Was not able to drain SSE data within timeout');
        resolve();
      }, 1000);
    });
  }
  // exit
  res.destroy();
}

function formatChunk({
  event,
  id,
  data = '',
}: {
  event?: string;
  id?: string | number;
  data?: string;
}): string {
  return [
    event !== undefined && `event: ${event}`,
    id !== undefined && `id: ${id}`,
    data !== undefined && `data: ${data}`,
    // add an extra newline for better viewing of concatenated stream
    '\n',
  ]
    .filter(Boolean)
    .join('\n');
}
