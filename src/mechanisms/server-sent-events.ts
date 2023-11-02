import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../logger';
import { getLastBlockHeight, waitForNextBlock } from '../sync';
import {
  BlockRangeRequestQuery,
  getBlockRange,
} from '../storage/sqlite3/db/blockRangeUtils';
import {
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
  shape: Shape,
  getData: GetEndpointData<PluginContext, DataSets>,
  getPaginatedResponse: GetEndpointResponse<DataSets, Shape>
): Promise<void> {
  const {
    from_height: fromHeight = 0,
    to_height: toHeight = Number.POSITIVE_INFINITY,
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
  let aborted = false;
  req.once('close', () => (aborted = true));
  // wait until we get new data (newer than known height header)
  while (!aborted) {
    // wait for next block
    try {
      // get current data from last known height
      const query: PaginatedRequestQuery & BlockRangeRequestQuery = {
        // default to only a "first height page" of small chunks
        'pagination.limit': !lastHeight && !offset ? '100' : '10000',
        ...request.query,
        'pagination.count_total': 'true',
        // add explicit block height range for caching (generating cache ID)
        'block_range.from_height': lastHeight.toFixed(0),
        'block_range.to_height': Math.min(
          toHeight,
          getLastBlockHeight()
        ).toFixed(0),
      };
      const data = await getData(request.params, query, h.context);
      if (aborted) break;
      const [height = lastHeight] = data || [];
      if (res.writable && height <= toHeight) {
        do {
          const queryWithOffset = {
            ...query,
            'pagination.offset': offset.toFixed(0),
          };
          const response = data && getPaginatedResponse(data, queryWithOffset);
          const page = response?.data;
          const pageSize =
            // calculate page size depending on the pagination being
            // of one list or multiple lists
            (response?.pagination?.totals?.length ?? 0) > 1
              ? (page as unknown[][]).reduce(
                  (acc, page) => Math.max(acc, page.length),
                  0
                )
              : page?.length ?? 0;
          const nextOffset = offset + (pageSize ?? 0);
          const total = response?.pagination?.total || 1;
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
                (await cachedStringify?.(
                  `${request.url.pathname}?${new URLSearchParams(
                    queryWithOffset
                  )}`,
                  page
                )) || JSON.stringify(page),
            })
          );

          // calculate next offset or reset to 0
          offset =
            pageSize && response?.pagination?.next_key ? offset + pageSize : 0;
        } while (offset > 0);
      }
      // if we were asked to stop at a certain height: stop
      // but I don't know why someone would request that
      if (height >= toHeight) {
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
    `data: ${data}`,
    // add an extra newline for better viewing of concatenated stream
    '\n',
  ]
    .filter(Boolean)
    .join('\n');
}
