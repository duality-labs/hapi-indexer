import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import getSwapVolume from '../../storage/sqlite3/db/event.TickUpdate/getSwapVolume';
import getTotalVolume from '../../storage/sqlite3/db/derived.tx_volume_data/getTotalVolume';

const routes = [
  {
    method: 'GET',
    path: '/timeseries/volume/{tokenA}/{tokenB}/{resolution?}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        return getSwapVolume(
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

  {
    method: 'GET',
    path: '/timeseries/tvl/{tokenA}/{tokenB}/{resolution?}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        return await getTotalVolume(
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
