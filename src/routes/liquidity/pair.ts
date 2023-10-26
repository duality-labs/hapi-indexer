import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import {
  DataRow,
  getHeightedTokenPairLiquidity,
} from '../../storage/sqlite3/db/derived.tick_state/getTokenPairLiquidity';
import {
  paginateData,
  PaginatedRequestQuery,
  PaginatedResponse,
} from '../../storage/sqlite3/db/paginationUtils';
import {
  BlockRangeRequestQuery,
  BlockRangeResponse,
  getBlockRange,
} from '../../storage/sqlite3/db/blockRangeUtils';
import { getLastBlockHeight, waitForNextBlock } from '../../sync';
import {
  getMsLeft,
  inMs,
  minutes,
} from '../../storage/sqlite3/db/timeseriesUtils';

interface PairLiquidityResponse extends PaginatedResponse, BlockRangeResponse {
  shape: [['tick_index', 'reserves'], ['tick_index', 'reserves']];
  data: [Array<DataRow>, Array<DataRow>];
}

const defaultPaginationLimit = 10000;
const timeoutMs = 3 * minutes * inMs;

async function getData(
  server: Request['server'],
  params: Request['params'],
  query: Partial<PaginatedRequestQuery & BlockRangeRequestQuery>
) {
  const blockRange = getBlockRange(query);
  const { from_height: fromHeight = 0, to_height: toHeight } = blockRange;
  return getHeightedTokenPairLiquidity(
    server,
    params['tokenA'],
    params['tokenB'],
    { fromHeight, toHeight }
  );
}

const routes = [
  {
    method: 'GET',
    path: '/liquidity/pair/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        const blockRange = getBlockRange(request.query);
        const { from_height: fromHeight = 0, to_height: toHeight } = blockRange;

        // get the liquidity data (but if we *will* wait for new data then skip)
        let data =
          fromHeight !== getLastBlockHeight()
            ? await getData(request.server, request.params, request.query)
            : null;

        // await new data if the data does not meet the known height requirement
        if (!toHeight) {
          const timeLeft = getMsLeft(timeoutMs);
          // wait until we get new non-empty data
          while (((data || []) as [][]).every((v) => !v?.length)) {
            // wait for next block
            try {
              await waitForNextBlock(timeLeft());
            } catch {
              // but throw timeout if waited for too long
              return h.response('Request Timeout').code(408);
            }
            // get current data
            data = await getData(request.server, request.params, request.query);
          }
        }

        // return errors if needed
        if (!data) {
          return h.response('Not Found').code(404);
        }

        const [height, tickStateA, tickStateB] = data;

        const { req, res } = request.raw;
        const canUseSSE =
          request.query['stream'] === 'true' && req.httpVersionMajor === 2;

        // use SSE if available
        if (canUseSSE) {
          // paginate the data
          const [pageA, paginationA] = paginateData(
            tickStateA,
            request.query, // the time extents and frequency and such
            Number.MAX_SAFE_INTEGER
          );
          const [pageB, paginationB] = paginateData(
            tickStateB,
            request.query, // the time extents and frequency and such
            Number.MAX_SAFE_INTEGER
          );
          const response: PairLiquidityResponse = {
            shape: [
              ['tick_index', 'reserves'],
              ['tick_index', 'reserves'],
            ],
            data: [pageA, pageB],
            pagination: {
              // the next key will be the same if it exists on both sides
              next_key: paginationA.next_key ?? paginationB.next_key,
              total:
                paginationA.total !== undefined &&
                paginationB.total !== undefined
                  ? paginationA.total + paginationB.total
                  : undefined,
            },
            // indicate what range the data response covers
            block_range: {
              from_height: fromHeight,
              to_height: height,
            },
          };
          // establish SSE content through headers
          h.response('')
            .type('text/event-stream')
            .header('Cache-Control', 'no-cache')
            .header('Connection', 'keep-alive');
          // return all initial data (not paginated)
          res.write(JSON.stringify(response));
          // and listen for new updates to send
          let lastHeight = response.block_range.to_height;
          let aborted = false;
          req.once('close', () => (aborted = true));
          // wait until we get new data (newer than known height header)
          while (!aborted) {
            // wait for next block
            try {
              // wait for next block or for user to end request
              await new Promise<void>((resolve, reject) => {
                function onClose() {
                  reject(new Error('User has closed SSE connection'));
                }
                // wait for close event
                req.once('close', onClose);
                // and wait for next block
                waitForNextBlock(Number.POSITIVE_INFINITY)
                  .then(() => {
                    // stop waiting for close event once next block has been found
                    req.removeListener('close', onClose);
                    resolve();
                  })
                  .catch(reject);
              });
              // get current data from last known height
              const query = {
                ...request.query,
                'block_range.from_height': lastHeight.toFixed(0),
              };
              const data = await getData(request.server, request.params, query);
              const [height = lastHeight, tickStateA = [], tickStateB = []] =
                data || [];
              if (!aborted && res.writable) {
                res.write(
                  // make the response chain a "newline separated JSON" string
                  // and still send newline chars with no data updates as a
                  // "heartbeat" signal
                  `\n\n${
                    height > lastHeight
                      ? JSON.stringify({
                          shape: [
                            ['tick_index', 'reserves'],
                            ['tick_index', 'reserves'],
                          ],
                          data: [tickStateA, tickStateB],
                          pagination: {
                            next_key: null,
                            total:
                              (tickStateA.length || 0) +
                              (tickStateB.length || 0),
                          },
                          // indicate what range the data response covers
                          block_range: {
                            from_height: lastHeight,
                            to_height: height,
                          },
                        })
                      : ''
                  }`
                );
                lastHeight = height;
              }
            } catch {
              // exit loop, request has finished
              break;
            }
          }
          res.destroy();
        } else {
          // paginate the data
          const [pageA, paginationA] = paginateData(
            tickStateA,
            request.query, // the time extents and frequency and such
            defaultPaginationLimit
          );
          const [pageB, paginationB] = paginateData(
            tickStateB,
            request.query, // the time extents and frequency and such
            defaultPaginationLimit
          );
          const response: PairLiquidityResponse = {
            shape: [
              ['tick_index', 'reserves'],
              ['tick_index', 'reserves'],
            ],
            data: [pageA, pageB],
            pagination: {
              // the next key will be the same if it exists on both sides
              next_key: paginationA.next_key ?? paginationB.next_key,
              total:
                paginationA.total !== undefined &&
                paginationB.total !== undefined
                  ? paginationA.total + paginationB.total
                  : undefined,
            },
            // indicate what range the data response covers
            block_range: {
              from_height: fromHeight,
              to_height: height,
            },
          };
          return response;
        }
      } catch (err: unknown) {
        if (err instanceof Error) {
          logger.error(err);
          return h
            .response(err.message || 'An unknown error occurred')
            .code(Number(err.cause) || 500);
        }
        return h.response('An unknown error occurred').code(500);
      }
    },
  },
];

export default routes;
