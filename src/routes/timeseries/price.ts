import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import getPrice from '../../storage/sqlite3/db/derived.tx_price_data/getPrice';

const routes = [
  {
    method: 'GET',
    path: '/timeseries/price/{tokenA}/{tokenB}/{resolution?}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        return await getPrice(
          request.params['tokenA'],
          request.params['tokenB'],
          request.params['resolution'],
          request.query // the time extents and frequency and such
        );
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
