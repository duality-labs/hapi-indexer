
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
  path: '/debug',
  handler: async (_, h) => {
    try {
      const tableNames = await new Promise((resolve, reject) => {
        db.all(`SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name`, [], (err, rows) => {
          if (err) {
            reject(err);
          }
          else {
            resolve(rows.map(row => row.name))
          }
        });
      })
      return Promise.all(tableNames.filter(name => name !== 'sqlite_sequence').map(tableName => {
        return new Promise((resolve, reject) => {
          db.all(`SELECT * FROM '${tableName}'`, [], (err, rows) => {
            if (err) {
              reject(err);
            }
            else {
              resolve([tableName, rows]);
            }
          });
        });
      })).then(tables => tables.reduce((acc, [tableName, rows]) => {
        acc[tableName] = rows;
        return acc;
      }, {}));
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
