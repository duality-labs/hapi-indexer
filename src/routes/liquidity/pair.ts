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
import { newHeightEmitter } from '../../sync';

interface PairLiquidityResponse extends PaginatedResponse, BlockRangeResponse {
  shape: [['tick_index', 'reserves'], ['tick_index', 'reserves']];
  data: [Array<DataRow>, Array<DataRow>];
}

const defaultPaginationLimit = 10000;

const routes = [
  {
    method: 'GET',
    path: '/liquidity/pair/{tokenA}/{tokenB}',
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

        // get the liquidity data
        let data = await getData();

        // await new data if the data does not meet the known height requirement
        if (data) {
          // wait until we get new data (newer than known height header)
          while ((data?.[0] || 0) <= fromHeight) {
            // wait for next block
            await new Promise((resolve) => {
              newHeightEmitter.once('newHeight', resolve);
            });
            // get current data
            data = await getData();
          }
        }

        // return errors if needed
        if (!data) {
          return h.response('Not Found').code(404);
        }

        const [height, tickStateA, tickStateB] = data;
        if (toHeight) {
          if (height > toHeight) {
            return h
              .response(
                `Token liquidity for height ${toHeight} data is no longer available`
              )
              .code(412);
          }
          if (height < toHeight) {
            return h
              .response(
                `Token liquidity for height ${toHeight} data is not yet available`
              )
              .code(412);
          }
        }

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
              paginationA.total !== undefined && paginationB.total !== undefined
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
      } catch (err: unknown) {
        if (err instanceof Error) {
          logger.error(err);
          return h
            .response(`something happened: ${err.message || '?'}`)
            .code(500);
        }
        return h.response('An unknown error occurred').code(500);
      }
    },
  },
];

export default routes;
