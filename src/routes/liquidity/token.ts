import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import {
  getHeightedTokenPairLiquidity,
  paginateTickLiquidity,
} from '../../storage/sqlite3/db/derived.tick_state/getTickLiquidity';
import { PaginatedRequestQuery } from '../../storage/sqlite3/db/paginationUtils';

const routes = [
  {
    method: 'GET',
    path: '/liquidity/token/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        // get requested height from match header
        const requestedHeight = Number(
          `${request.headers.get('If-Match')}`.split('-').at(0)
        );

        // get the liquidity data
        const data = await getHeightedTokenPairLiquidity(
          request.server,
          request.params['tokenA'],
          request.params['tokenB'],
          requestedHeight
        );

        // return errors if needed
        if (!data) {
          return h.response('Not Found').code(404);
        }

        const [height, tickStateA] = data;
        if (requestedHeight) {
          if (height > requestedHeight) {
            return h
              .response(
                `Token liquidity for height ${requestedHeight} data is no longer available`
              )
              .code(412);
          }
          if (height < requestedHeight) {
            return h
              .response(
                `Token liquidity for height ${requestedHeight} data is not yet available`
              )
              .code(412);
          }
        }

        // create tag from height and pagination key
        h.entity({
          etag: [
            height,
            (request.query as PaginatedRequestQuery)['pagination.key'],
          ]
            .filter(Boolean)
            .join('-'),
        });

        // paginate the data
        return paginateTickLiquidity(
          tickStateA,
          request.query // the time extents and frequency and such
        );
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
