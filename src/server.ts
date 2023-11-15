import fs from 'node:fs';
import http, { Server } from 'node:http';
import http2, { Http2SecureServer } from 'node:http2';
import Hapi from '@hapi/hapi';
import logger from './logger';

import db, { init as initDb } from './storage/sqlite3/db/db';
import initDbSchema from './storage/sqlite3/schema/schema';
import * as sync from './sync';

import globalPlugins from './plugins';
import { plugin as liquidityPlugin } from './routes/liquidity';
import { plugin as timeseriesPlugin } from './routes/timeseries';
import routes from './routes';
import { inMs, minutes } from './storage/sqlite3/db/timeseriesUtils';

function safeReadFileText(filename: string) {
  if (filename && fs.existsSync(filename)) {
    return fs.readFileSync(filename);
  }
}

const {
  RPC_API = '',
  ALLOW_ROUTES_BEFORE_SYNCED = '',
  SSL_PRIVATE_KEY_FILE = 'ssl-key.pem',
  SSL_PUBLIC_KEY_FILE = 'ssl-cert.pem',
  SSL_PRIVATE_KEY = safeReadFileText(SSL_PRIVATE_KEY_FILE) || '',
  SSL_PUBLIC_KEY = safeReadFileText(SSL_PUBLIC_KEY_FILE) || '',
} = process.env;

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

  // setup either a secure HTTP2 server or normal HTTP server
  // depending on whether SSL keys are available
  let isSecure = false;
  let rawServer: (Http2SecureServer & Partial<Server>) | Server | null = null;
  try {
    if (!SSL_PUBLIC_KEY || !SSL_PRIVATE_KEY) {
      throw new Error('Cannot create secure server without keys');
    }
    // add HTTP2 server with added properties to bring in line with HTTP server
    rawServer = http2.createSecureServer({
      key: SSL_PRIVATE_KEY,
      cert: SSL_PUBLIC_KEY,
    }) as Http2SecureServer & Partial<Server>;
    rawServer.maxHeadersCount = null;
    rawServer.maxRequestsPerSocket = null;
    rawServer.timeout = 5 * minutes * inMs;
    rawServer.headersTimeout = 1 * minutes * inMs;
    rawServer.keepAliveTimeout = 1 * minutes * inMs;
    rawServer.requestTimeout = 5 * minutes * inMs;
    rawServer.closeAllConnections = () => undefined;
    rawServer.closeIdleConnections = () => undefined;
    isSecure = true;
  } catch (e) {
    logger.info(`Could not create secure server: ${(e as Error)?.message}`);
    rawServer = http.createServer();
  }

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
        additionalHeaders: ['X-Requested-With'],
      },
    },
    listener: rawServer as Server,
    tls: isSecure,
  });

  await server.register(globalPlugins);

  // add status route
  server.route({
    method: 'GET',
    path: '/',
    handler: () => {
      return {
        status: 'OK',
        http2Available: isSecure,
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
  // prevent routes from being usable until the indexer is synced with the chain
  if (ALLOW_ROUTES_BEFORE_SYNCED !== 'true') {
    await sync.catchUp();
  }
  serverTimes.indexed = new Date();

  // and indexer plugin routes
  server.register([liquidityPlugin, timeseriesPlugin]);

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
