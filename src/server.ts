import Hapi from '@hapi/hapi';
import logger from './logger';

import db, { init as initDb } from './storage/sqlite3/db/db';
import initDbSchema from './storage/sqlite3/schema/schema';
import * as sync from './sync';

import routes from './routes';

const { REST_API = '' } = process.env;

async function testConnection(apiUrl: string): Promise<boolean> {
  try {
    logger.info(`testing connection to API: ${apiUrl}`);

    // fetch the transactions from block 0 (which should be empty)
    const response = await fetch(
      `${apiUrl}/cosmos/tx/v1beta1/txs?events=tx.height=0`
    );

    if (response.status !== 200) {
      throw new Error(`API returned status code: ${response.status}`);
    }

    const result = (await response.json()) as { txs: [] };
    if (result && parseInt(`${result.txs.length}`) >= 0) {
      logger.info(`connected to API: ${apiUrl}`);
      return true;
    } else {
      throw new Error(`API returned unexpected response: ${result}`);
    }
  } catch (err) {
    logger.error(`connection to API failed: ${err}`);
  }
  return false;
}

const init = async () => {
  // test our connection to the chain before starting
  const startTime = Date.now();
  let connected = false;
  do {
    connected = await testConnection(REST_API);
    if (!connected) {
      // exponentially back off the connection test (capped at 1 minute)
      const waitTime = Math.min(Date.now() - startTime, 1000 * 60);
      logger.info(
        `waiting ${waitTime / 1000}s before retrying connection test`
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  } while (!connected);

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
            ? [process.env.CORS_ORIGIN || 'app.duality.xyz'] // production CORS settings
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
