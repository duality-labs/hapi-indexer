import Hapi from '@hapi/hapi';
import logger from './logger.mjs';

import * as db from './storage/sqlite3/index.mjs';
import * as sync from './sync.mjs';

import dbClient from './storage/sqlite3/db.mjs'

import { volume } from './storage/sqlite3/stats.mjs';

const init = async () => {

  // wait for database to be set up before creating server
  await db.init();
  await sync.catchUp();

  const server = Hapi.server({
    port: 8000,
    // host: 0.0.0.0 resolves better than host: localhost in a Docker container
    host: '0.0.0.0',
  });

  server.route({
    method: 'GET',
    path: '/',
    handler: () => 'ok',
  });

  if (process.env.NODE_ENV === 'development') server.route({
    method: 'GET',
    path: '/debug',
    handler: async (_, h) => {
      try {
        const tableNames = await new Promise((resolve, reject) => {
          dbClient.all(`SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name`, [], (err, rows) => {
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
            dbClient.all(`SELECT * FROM '${tableName}'`, [], (err, rows) => {
              if (err) {
                reject(err);
              }
              else {
                resolve([tableName, rows]);
              }
            });
          });
        })).then(tables => tables.reduce((acc, [tableName, rows], index) => {
          acc[tableName] = rows;
          return acc;
        }, {}));
      }
      catch (err) {
        console.log('err', err);
        return h.response(`something happened: ${err.message || '?'}`).code(500);
      }
    },
  });

  server.route({
    method: 'GET',
    path: '/stats/volume',
    handler: async (_, h) => {
      try {
        return {
          days: {
            7: await volume({ lastDays: 7 }),
          },
        };
      }
      catch (err) {
        console.log('err', err);
        return h.response(`something happened: ${err.message || '?'}`).code(500);
      }
    },
  });

  await server.start();
  logger.info(`Server running on ${server.info.uri}`);

  await sync.keepUp();
};

process.on('unhandledRejection', (err) => {
  logger.error(err);
  db.close();
  process.exit(1);
});

init();
