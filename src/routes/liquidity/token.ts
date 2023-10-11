import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import {
  DataRow,
  getHeightedTokenPairLiquidity,
} from '../../storage/sqlite3/db/derived.tick_state/getTickLiquidity';
import {
  decodePagination,
  paginateData,
  PaginatedResponse,
} from '../../storage/sqlite3/db/paginationUtils';
import {
  BlockRangeResponse,
  getBlockRange,
} from '../../storage/sqlite3/db/blockRangeUtils';
import { newHeightEmitter } from '../../sync';

interface TickLiquidityResponse extends PaginatedResponse, BlockRangeResponse {
  shape: ['tick_index', 'reserves'];
  data: Array<DataRow>;
}

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

        const [height, tickStateA] = data;
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

        // create tag from height and { offset, limit } pagination keys
        const { offset, limit } = decodePagination(request.query, 10000);
        const etag = [fromHeight, height, offset, limit].join('-');
        h.entity({ etag });

        // paginate the data
        const [page, pagination] = paginateData(
          tickStateA,
          request.query, // the time extents and frequency and such
          10000
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
            .response(`something happened: ${err.message || '?'}`)
            .code(500);
        }
        return h.response('An unknown error occurred').code(500);
      }
    },
  },
];

export default routes;
