import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import getPrice from '../../storage/sqlite3/db/derived.tx_price_data/getPrice';
import { hours } from '../../storage/sqlite3/db/timeseriesUtils';

const routes = [
  {
    method: 'GET',
    path: '/stats/price/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        // round down to the passing of the most recent minute
        const mostRecentMinuteUnix = new Date().setSeconds(0, 0) / 1000;
        const [
          {
            data: [lastestDay],
            shape,
          },
          {
            data: [previousDay],
          },
        ] = await Promise.all([
          getPrice(
            request.params['tokenA'],
            request.params['tokenB'],
            'day',
            {
              'pagination.limit': '1',
              'pagination.before': `${mostRecentMinuteUnix}`,
            },
            'last24Hours'
          ),
          getPrice(
            request.params['tokenA'],
            request.params['tokenB'],
            'day',
            {
              'pagination.limit': '1',
              'pagination.before': `${mostRecentMinuteUnix - 24 * hours}`,
            },
            'last24Hours'
          ),
        ]);
        return { shape, data: [lastestDay, previousDay] };
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
