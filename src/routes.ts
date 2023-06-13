import { Request, ResponseToolkit } from '@hapi/hapi';
import sql from 'sql-template-strings';

import db from './storage/sqlite3/db/db';
import logger from './logger';

import timeseriesPriceRoutes from './routes/timeseries/price';
import timeseriesVolumeRoutes from './routes/timeseries/volume';

import statPriceroutes from './routes/stats/price';
import statVolumeroutes from './routes/stats/volume';
import statVolatilityRoutes from './routes/stats/volatility';

const rootPath = {
  method: 'GET',
  path: '/',
  handler: () => 'ok',
};

// add debug path
const debugPath = {
  method: 'GET',
  path: '/debug/{limitOrAll?}',
  handler: async (request: Request, h: ResponseToolkit) => {
    // set limit to all or the given number (defaulting to 100)
    const limit =
      request.params['limitOrAll'] === 'all'
        ? 0
        : Number(request.params['limitOrAll']) || 100;
    try {
      const tableNames = await db
        .all(
          sql`SELECT name FROM 'sqlite_schema' WHERE type='table' ORDER BY name`
        )
        .then((rows) => rows.map((row) => row.name));
      // return as rows keyed under the table name
      const tableEntries = await Promise.all(
        tableNames
          .filter((name) => name !== 'sqlite_sequence')
          .map(async (tableName) => {
            return await db
              .all(
                `SELECT * FROM '${tableName}' ORDER BY _rowid_ DESC${
                  Number(limit) > 0 ? ` LIMIT ${limit}` : ''
                }`
              )
              .then((rows) => [tableName, rows]);
          })
      );
      return Object.fromEntries(tableEntries);
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
};

const routes = [
  // add utility routes
  rootPath,

  // timeseries routes
  ...timeseriesPriceRoutes,
  ...timeseriesVolumeRoutes,

  // point in time stats
  ...statPriceroutes,
  ...statVolumeroutes,
  ...statVolatilityRoutes,

  // add development only paths
  ...(process.env.NODE_ENV === 'development' ? [debugPath] : []),
];

export default routes;
