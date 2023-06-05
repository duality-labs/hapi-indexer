import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import getPrice from '../../storage/sqlite3/db/derived.tx_price_data/getPrice';

const routes = [
  {
    method: 'GET',
    path: '/stats/price/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        const {
          shape,
          data: [firstRow],
        } = await getPrice(
          request.params['tokenA'],
          request.params['tokenB'],
          'second',
          { 'pagination.limit': '1' }
        );
        return { shape, data: firstRow };
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
