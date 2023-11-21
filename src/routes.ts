import { Request, ResponseToolkit } from '@hapi/hapi';
import sql from 'sql-template-tag';

import db, { prepare } from './storage/sqlite3/db/db';
import logger from './logger';

// add debug route
const debugRoute = {
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
          ...prepare(
            sql`SELECT name FROM 'sqlite_schema' WHERE type='table' ORDER BY name`
          )
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

export const onStartRoutes = [
  // add development only paths
  ...(process.env.NODE_ENV === 'development' ? [debugRoute] : []),
];

// note: most "on sync" data endpoints are provided through plugins
//       in src/routes/*/index.ts files now (which simplifies caching a little)
export const onSyncRoutes = [];
