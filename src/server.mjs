import Hapi from '@hapi/hapi';
import logger from './logger.mjs';

import * as db from './storage/sqlite3/index.mjs';
import * as sync from './sync.mjs';

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
