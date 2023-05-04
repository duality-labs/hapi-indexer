import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import getPricePerSecond from '../../storage/sqlite3/db/derived.tx_price_data/getPricePerSecond';

const routes = [
  {
    method: 'GET',
    path: '/timeseries/price/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        return await getPricePerSecond(
          request.params['tokenA'],
          request.params['tokenB'],
          request.query // the time extents and frequency and such
        );
      } catch (err: unknown) {
        if (err instanceof Error) {
          logger.error(err);
          return h.response(`something happened: ${err.message || '?'}`).code(500);
        }
        return h.response('An unknown error occurred').code(500);
      }
    },
  },
];

export default routes;
