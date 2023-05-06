import Hapi from '@hapi/hapi';
import logger from './logger';

import db, { init as initDb } from './storage/sqlite3/db/db';
import initDbSchema from './storage/sqlite3/schema/schema';
import * as sync from './sync';

import routes from './routes';

const init = async () => {
  // wait for database to be set up before creating server
  await initDb();
  await initDbSchema();
  await sync.catchUp();

  const server = Hapi.server({
    port: 8000,
    // host: 0.0.0.0 resolves better than host: localhost in a Docker container
    host: '0.0.0.0',
    routes: {
      cors: {
        origin:
          process.env.NODE_ENV !== 'development'
            ? ['app.duality.xyz'] // production CORS settings
            : ['*'], // development CORS settings
        headers: ['Accept', 'Content-Type'],
        additionalHeaders: ['X-Requested-With'],
      },
    },
  });

  // add routes
  routes.forEach((route) => {
    server.route(route);
  });

  await server.start();
  logger.info(`Server running on ${server.info.uri}`);

  await sync.keepUp();
};

process.on('unhandledRejection', async (err) => {
  logger.error(err);
  await db.close();
  process.exit(1);
});

init();
