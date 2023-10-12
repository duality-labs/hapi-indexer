import Hapi from '@hapi/hapi';
import logger from './logger';

import db, { init as initDb } from './storage/sqlite3/db/db';
import initDbSchema from './storage/sqlite3/schema/schema';
import * as sync from './sync';

import routes from './routes';

const { RPC_API = '' } = process.env;

async function testConnection(apiUrl: string): Promise<boolean> {
  try {
    logger.info(`testing connection to API: ${apiUrl}`);

    // fetch the transactions from block 0 (which should be empty)
    const response = await fetch(`${apiUrl}/tx_search?query="tx.height=0"`);

    if (response.status !== 200) {
      throw new Error(`API returned status code: ${response.status}`);
    }

    const { result } = (await response.json()) as { result: { txs: [] } };
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

const serverTimes: {
  starting?: Date;
  started?: Date;
  connecting?: Date;
  connected?: Date;
  indexing?: Date;
  indexed?: Date;
} = {};

const init = async () => {
  // test our connection to the chain before starting
  serverTimes.connecting = new Date();
  let connected = false;
  do {
    connected = await testConnection(RPC_API);
    if (!connected) {
      // exponentially back off the connection test (capped at 1 minute)
      const waitTime = Math.min(
        Date.now() - serverTimes.connecting.valueOf(),
        1000 * 60 // wait a maximum of 1 minute
      );
      logger.info(
        `waiting ${waitTime / 1000}s before retrying connection test`
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  } while (!connected);
  serverTimes.connected = new Date();

  // start server before adding in indexer routes
  // (so that the server may report the indexing status)
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
      },
    },
  });

  // add status route
  server.route({
    method: 'GET',
    path: '/',
    handler: () => {
      return {
        status: 'OK',
        server: {
          status: serverTimes.started
            ? 'OK'
            : serverTimes.starting
            ? 'STARTING'
            : 'OFFLINE',
          since: serverTimes.started?.toISOString(),
        },
        upstream: {
          status: serverTimes.connected
            ? 'OK'
            : serverTimes.connecting
            ? 'CONNECTING'
            : 'OFFLINE',
          since: serverTimes.connected?.toISOString(),
        },
        indexer: {
          status: serverTimes.indexed
            ? 'OK'
            : serverTimes.indexing
            ? 'INDEXING'
            : 'OFFLINE',
          since: serverTimes.indexed?.toISOString(),
        },
      };
    },
  });

  serverTimes.starting = new Date();
  await server.start();
  logger.info(`Server running on ${server.info.uri}`);
  serverTimes.started = new Date();

  // wait for database to be set up before adding indexer routes
  await initDb();
  await initDbSchema();
  serverTimes.indexing = new Date();
  await sync.catchUp();
  serverTimes.indexed = new Date();

  // add indexer routes
  routes.forEach((route) => {
    server.route(route);
  });

  await sync.keepUp();
};

process.on('unhandledRejection', async (err) => {
  logger.error(err);
  await db.close();
  process.exit(1);
});

init();
