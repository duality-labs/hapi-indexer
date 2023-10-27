import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../logger';
import { waitForNextBlock } from '../sync';
import {
  BlockRangeRequestQuery,
  getBlockRange,
} from '../storage/sqlite3/db/blockRangeUtils';
import { GetEndpointData, GetEndpointResponse } from './types';

export default async function serverSentEventRequest<
  DataSets extends unknown[],
  Shape
>(
  request: Request,
  h: ResponseToolkit,
  getData: GetEndpointData<DataSets>,
  getResponse: GetEndpointResponse<DataSets, Shape>,
  shape: Shape
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
      data: '"block_range.to_height"',
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
  // and listen for new updates to send
  let lastHeight = fromHeight;
  let aborted = false;
  req.once('close', () => (aborted = true));
  // wait until we get new data (newer than known height header)
  while (!aborted) {
    // wait for next block
    try {
      // get current data from last known height
      const query: BlockRangeRequestQuery = {
        ...request.query,
        'block_range.from_height': lastHeight.toFixed(0),
      };
      const data = await getData(request.server, request.params, query);
      if (aborted) break;
      const [height = lastHeight] = data || [];
      if (res.writable && height <= toHeight) {
        res.write(
          // send event responses with or without data: "empty" updates are a
          // "heartbeat" signal
          formatChunk({
            event: 'update',
            id: height,
            data:
              data && height > lastHeight
                ? JSON.stringify(
                    // get only the unpaginated data field
                    getResponse(data, query, {
                      paginate: false,
                      shape: false,
                      defaults: {},
                    }).data
                  )
                : '',
          })
        );
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
