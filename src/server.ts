import fs from 'node:fs';
import http, { Server } from 'node:http';
import http2, { Http2SecureServer } from 'node:http2';
import Hapi from '@hapi/hapi';
import logger from './logger';

import globalPlugins from './plugins';
import { routes } from './routes';
import { inMs, minutes } from './utils/time';

import { SingleDocumentJSONFormat } from '@clickhouse/client';
import { client } from './client';

function safeReadFileText(filename: string) {
  if (filename && fs.existsSync(filename)) {
    return fs.readFileSync(filename);
  }
}

const {
  PORT = '8000',
  CORS_ALLOWED_ORIGINS = '',
  SSL_PRIVATE_KEY_FILE = 'ssl-key.pem',
  SSL_PUBLIC_KEY_FILE = 'ssl-cert.pem',
  SSL_PRIVATE_KEY = safeReadFileText(SSL_PRIVATE_KEY_FILE) || '',
  SSL_PUBLIC_KEY = safeReadFileText(SSL_PUBLIC_KEY_FILE) || '',
  CLICKHOUSE_DB_HOST = '',
  CLICKHOUSE_DB_PORT = '',
} = process.env;

async function testConnection(): Promise<boolean> {
  try {
    logger.info(
      `testing connection to DB: ${CLICKHOUSE_DB_HOST}:${CLICKHOUSE_DB_PORT}`
    );

    const pingStart = Date.now();
    const ping = await client.ping();
    logger.info(
      `testing connection to DB: ping took ${Date.now() - pingStart}ms`
    );

    if (!ping.success) {
      throw new Error('DB did not return ping');
    }

    const queryStart = Date.now();
    const response = await client.query<SingleDocumentJSONFormat>({
      query: 'SELECT 1',
    });
    logger.info(
      `testing connection to DB: got response in ${Date.now() - queryStart}ms`
    );
    const json = await response.json();
    return json.rows === 1;
  } catch (err) {
    logger.error(`connection to DB failed: ${err}`);
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
    connected = await testConnection();
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
    port: PORT,
    // host: 0.0.0.0 resolves better than host: localhost in a Docker container
    host: '0.0.0.0',
    routes: {
      cors: {
        // CORS origins may be a comma separated list as a string
        // note that "*" may be a wildcard for all origins but may also
        // be used to whitelist an origin pattern, eg. https://*.neutron.org
        // docs: https://hapi.dev/api/?v=21.3.3#-routeoptionscors
        origin: CORS_ALLOWED_ORIGINS.split(',').map((v) => v.trim()),
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

  // add "on start" routes
  server.route(routes);

  serverTimes.starting = new Date();
  await server.start();
  logger.info(`Server running on ${server.info.uri}`);
  serverTimes.started = new Date();
};

process.on('unhandledRejection', async (err) => {
  logger.error(err);
  await client.close();
  process.exit(1);
});

init();
