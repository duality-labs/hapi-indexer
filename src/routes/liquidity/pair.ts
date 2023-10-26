import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import {
  DataRow,
  HeightedTokenPairLiquidity,
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

interface PairLiquidityResponse
  extends Partial<PaginatedResponse>,
    BlockRangeResponse {
  shape?: [['tick_index', 'reserves'], ['tick_index', 'reserves']];
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

function getResponse(
  data: HeightedTokenPairLiquidity,
  query: PaginatedRequestQuery & BlockRangeRequestQuery,
  { paginate, shape }: { paginate: boolean; shape: boolean }
) {
  const [height, tickStateA = [], tickStateB = []] = data || [];
  const response: PairLiquidityResponse = {
    ...(shape && {
      shape: [
        ['tick_index', 'reserves'],
        ['tick_index', 'reserves'],
      ],
    }),
    ...(paginate
      ? // use unpaginated data
        (() => {
          // paginate the data
          const [pageA, paginationA] = paginateData(
            tickStateA,
            query, // the time extents and frequency and such
            defaultPaginationLimit
          );
          const [pageB, paginationB] = paginateData(
            tickStateB,
            query, // the time extents and frequency and such
            defaultPaginationLimit
          );
          return {
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
          };
        })()
      : // or use unpaginated data
        { data: [tickStateA, tickStateB] }),
    // indicate what range the data response covers
    block_range: {
      from_height: getBlockRange(query).from_height || 0,
      to_height: height,
    },
  };
  return response;
}

const routes = [
  {
    method: 'GET',
    path: '/liquidity/pair/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        const blockRange = getBlockRange(request.query);
        const { from_height: fromHeight = 0, to_height: toHeight } = blockRange;

        const { req, res } = request.raw;
        const canUseSSE =
          request.query['stream'] === 'true' && req.httpVersionMajor === 2;

        // use SSE if available
        if (canUseSSE) {
          // establish SSE content through headers
          h.response('')
            .type('text/event-stream')
            .header('Cache-Control', 'no-cache')
            .header('Connection', 'keep-alive');
          // and listen for new updates to send
          let lastHeight = fromHeight;
          let aborted = false;
          req.once('close', () => (aborted = true));
          // wait until we get new data (newer than known height header)
          while (!aborted) {
            // wait for next block
            try {
              // get current data from last known height
              const query = {
                ...request.query,
                'block_range.from_height': lastHeight.toFixed(0),
              };
              const data = await getData(request.server, request.params, query);
              if (aborted) break;
              const [height = lastHeight] = data || [];
              if (res.writable) {
                res.write(
                  // make the response chain a "newline separated JSON" string
                  // and still send newline chars with no data updates as a
                  // "heartbeat" signal
                  `\n\n${
                    data && height > lastHeight
                      ? JSON.stringify(
                          getResponse(data, query, {
                            paginate: false,
                            shape: lastHeight === fromHeight,
                          })
                        )
                      : ''
                  }`
                );
              }
              // wait for next block
              await waitForNextBlock(Number.POSITIVE_INFINITY);
              lastHeight = height;
            } catch {
              // exit loop, likely getData has failed somehow
              break;
            }
          }
          res.destroy();
        } else {
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
              data = await getData(
                request.server,
                request.params,
                request.query
              );
            }
          }

          // return errors if needed
          if (!data) {
            return h.response('Not Found').code(404);
          }

          return getResponse(data, request.query, {
            paginate: true,
            shape: true,
          });
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
