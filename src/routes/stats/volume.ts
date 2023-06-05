import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import getSwapVolume from '../../storage/sqlite3/db/event.TickUpdate/getSwapVolume';
import getTotalVolume from '../../storage/sqlite3/db/derived.tx_volume_data/getTotalVolume';

const routes = [
  {
    method: 'GET',
    path: '/stats/volume/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        const {
          shape,
          data: [firstRow],
        } = await getSwapVolume(
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

  {
    method: 'GET',
    path: '/stats/tvl/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        const {
          shape,
          data: [firstRow],
        } = await getTotalVolume(
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
