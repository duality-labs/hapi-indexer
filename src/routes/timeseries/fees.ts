import { Request, ResponseToolkit } from '@hapi/hapi';

import logger from '../../logger';
import getFees from '../../storage/sqlite3/db/event.TickUpdate/getFees';

const routes = [
  {
    method: 'GET',
    path: '/timeseries/fees/{tokenA}/{tokenB}/{resolution?}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        return getFees(
          request.params['tokenA'],
          request.params['tokenB'],
          request.params['resolution'],
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
