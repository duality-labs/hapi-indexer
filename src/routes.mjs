
import db from './storage/sqlite3/db.mjs';
import logger from './logger.mjs';

import timeseriesPriceRoutes from './routes/timeseries/price.mjs';
import statVolumeroutes from './routes/stats/volume.mjs';


const rootPath = {
  method: 'GET',
  path: '/',
  handler: () => 'ok',
};

// add debug path
const debugPath = {
  method: 'GET',
  path: '/debug/{limitOrAll?}',
  handler: async (request, h) => {
    // set limit to all or the given number (defaulting to 100)
    const limit = request.params['limitOrAll'] === 'all'
      ? 0
      : Number(request.params['limitOrAll']) || 100;
    try {
      const tableNames = 
        await db
          .all(`SELECT name FROM 'sqlite_schema' WHERE type='table' ORDER BY name`, [])
          .then((rows) => rows.map(row => row.name));
      // return as rows keyed under the table name
      const tableEntries = await Promise.all(tableNames.filter(name => name !== 'sqlite_sequence').map(async tableName => {
        return await db
          .all(`SELECT * FROM '${tableName}'`, [])
          .then((rows) => [tableName, rows.slice(-limit)]);
      }));
      return Object.fromEntries(tableEntries);
    }
    catch (err) {
      logger.error(err);
      return h.response(`something happened: ${err.message || '?'}`).code(500);
    }
  },
}

const routes = [

  // add utility routes
  rootPath,

  // timeseries routes
  ...timeseriesPriceRoutes,

  // point in time stats
  ...statVolumeroutes,

  // add development only paths
  ...process.env.NODE_ENV === 'development' ? [
    debugPath,
  ] : [],

];

export default routes;
