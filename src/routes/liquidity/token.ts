import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import {
  DataRow,
  getHeightedTokenPairLiquidity,
} from '../../storage/sqlite3/db/derived.tick_state/getTokenPairLiquidity';
import {
  paginateData,
  PaginatedResponse,
} from '../../storage/sqlite3/db/paginationUtils';
import {
  BlockRangeResponse,
  getBlockRange,
} from '../../storage/sqlite3/db/blockRangeUtils';
import { getLastBlockHeight, waitForNextBlock } from '../../sync';
import {
  getMsLeft,
  inMs,
  minutes,
} from '../../storage/sqlite3/db/timeseriesUtils';

interface TickLiquidityResponse extends PaginatedResponse, BlockRangeResponse {
  shape: ['tick_index', 'reserves'];
  data: Array<DataRow>;
}

const defaultPaginationLimit = 10000;
const timeoutMs = 3 * minutes * inMs;

const routes = [
  {
    method: 'GET',
    path: '/liquidity/token/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        const blockRange = getBlockRange(request.query);
        const { from_height: fromHeight = 0, to_height: toHeight } = blockRange;

        const getData = () =>
          getHeightedTokenPairLiquidity(
            request.server,
            request.params['tokenA'],
            request.params['tokenB'],
            { fromHeight, toHeight }
          );

        // get the liquidity data (but if we *will* wait for new data then skip)
        let data = fromHeight !== getLastBlockHeight() ? await getData() : null;

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
            data = await getData();
          }
        }

        // return errors if needed
        if (!data) {
          return h.response('Not Found').code(404);
        }

        const [height, tickStateA] = data;

        // paginate the data
        const [page, pagination] = paginateData(
          tickStateA,
          request.query, // the time extents and frequency and such
          defaultPaginationLimit
        );
        const response: TickLiquidityResponse = {
          shape: ['tick_index', 'reserves'],
          data: page,
          pagination,
          // indicate what range the data response covers
          block_range: {
            from_height: fromHeight,
            to_height: height,
          },
        };
        return response;
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
