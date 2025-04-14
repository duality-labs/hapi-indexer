import fs from 'node:fs';
import Router, { ExtendedRequest } from 'router';
import url from 'url';
import cors from 'cors';
import finalhandler from 'finalhandler';
import http, { IncomingMessage, Server, ServerResponse } from 'node:http';
import http2, { Http2SecureServer } from 'node:http2';
import logger from './utils/logger';

import { inMs, minutes } from './utils/units';

import { ResponseJSON, SingleDocumentJSONFormat } from '@clickhouse/client';
import { client } from './utils/client';
import { router as routes } from './routes';

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
  ALLOW_HTTP_1 = '',
  CLICKHOUSE_DB_HOST = '',
  CLICKHOUSE_DB_PORT = '',
  CLICKHOUSE_DB_PASS = '',
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

    // skip DB check if there are no base credentials
    if (!CLICKHOUSE_DB_PASS) {
      return true;
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

  const router = Router();

  // use CORS middleware
  router.use(
    cors({
      origin: CORS_ALLOWED_ORIGINS.split(',').map((v) => v.trim()),
      methods: ['GET', 'POST'],
      allowedHeaders: ['Accept', 'Content-Type'],
    })
  );

  // adde query property into req
  router.use((req, _, next) => {
    const query = url.parse(req.url ?? '').query;
    (req as ExtendedRequest).query = query
      ? Array.from(new URLSearchParams(query).entries()).reduce<
          Record<string, string>
        >((acc, [key, value]) => {
          acc[key] = value;
          return acc;
        }, {})
      : {};
    next();
  });

  router.use(routes);

  // add status route
  router.get('/', (req, res) => {
    res.setHeader('content-type', 'application/json');
    new Promise<ResponseJSON<'JSON'>>((resolve, reject) => {
      // race against timeout
      const timeout = setTimeout(
        () => reject(new Error('query time out')),
        3000
      );
      // query DB for status data
      client
        .query({
          query: `--sql
            SELECT
              count(*) AS block_count,
              block_count / (max_height - min_height + 1) AS block_coverage,
              min("height") AS min_height,
              max("height") AS max_height,
              max("timestamp") AS max_time,
              NOW() AS query_time,
              query_time - max_time AS lag_time
            FROM spacebox.raw_block_results
          `,
        })
        .then((data) => data.json<'JSON'>())
        .then(resolve)
        .catch(reject)
        .finally(() => clearTimeout(timeout));
    })
      .then((data) => ({ result: data, error: null }))
      .catch((error) => ({ error, result: null }))
      .then(({ result, error }) => {
        const data = result?.data?.at(0) as
          | { block_coverage: number; lag_time: number }
          | undefined;
        const serverStatus = serverTimes.started
          ? 'OK'
          : serverTimes.starting
          ? 'STARTING'
          : 'OFFLINE';
        const dbStatus =
          data && data.block_coverage >= 1 && data.lag_time <= 10
            ? 'OK'
            : data && data.block_coverage < 1
            ? 'INCOMPLETE_DATA'
            : data && data.lag_time > 10
            ? 'LAGGING_DATA'
            : 'NO_DATA';
        //  return statuses
        res.end(
          JSON.stringify({
            status:
              serverStatus === 'OK' && dbStatus === 'OK' ? 'OK' : 'NOT_OK',
            http2Available: req.httpVersionMajor >= 2,
            server: {
              status: serverStatus,
              since: serverTimes.started?.toISOString(),
            },
            db: {
              status: dbStatus,
              query: {
                ...result?.data,
                // return single row of data object
                data,
              },
              error: error?.message,
              since: serverTimes.connected?.toISOString(),
            },
          })
        );
      });
  });

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    router(req, res, finalhandler(req, res));
  };

  // setup either a secure HTTP2 server or normal HTTP server
  // depending on whether SSL keys are available
  serverTimes.starting = new Date();
  let rawServer: (Http2SecureServer & Partial<Server>) | Server | null = null;
  try {
    if (!SSL_PUBLIC_KEY || !SSL_PRIVATE_KEY) {
      throw new Error('Cannot create secure server without keys');
    }
    // add HTTP2 server with added properties to bring in line with HTTP server
    rawServer = http2.createSecureServer(
      {
        key: SSL_PRIVATE_KEY,
        cert: SSL_PUBLIC_KEY,
        allowHTTP1: ALLOW_HTTP_1 === 'true',
      },
      handler as unknown as undefined
    ) as Http2SecureServer & Partial<Server>;
    rawServer.maxHeadersCount = null;
    rawServer.maxRequestsPerSocket = null;
    rawServer.timeout = 5 * minutes * inMs;
    rawServer.headersTimeout = 1 * minutes * inMs;
    rawServer.keepAliveTimeout = 1 * minutes * inMs;
    rawServer.requestTimeout = 5 * minutes * inMs;
    rawServer.closeAllConnections = () => undefined;
    rawServer.closeIdleConnections = () => undefined;
  } catch (e) {
    logger.info(`Could not create secure server: ${(e as Error)?.message}`);
    rawServer = http.createServer(handler);
  }

  // Handle TLS errors gracefully
  rawServer.on('tlsClientError', (err, socket) => {
    logger.error('Server encountered TLS Error:', err.message);
    // Terminate the bad connection
    try {
      socket?.destroy();
      logger.info('Dropped socket connection', socket?.destroyed);
    } catch (e) {
      logger.warn('Could not drop socket connection', (e as Error)?.message);
    }
  });

  rawServer.listen(PORT, () => {
    logger.info(`Server running on ${JSON.stringify(rawServer.address())}`);
    serverTimes.started = new Date();
    // send ready signal to PM2
    process.send?.('ready');
  });
};

async function shutdown() {
  try {
    await new Promise((resolve, reject) => {
      // close DB connection
      client
        .close()
        .then(() => {
          clearTimeout(timeout);
          resolve(undefined);
        })
        .catch((e) => {
          clearTimeout(timeout);
          reject(e);
        });
      // or timeout
      const timeout = setTimeout(
        () => reject(new Error('DB close timeout')),
        3000
      );
    });
    logger.info('exited cleanly');
    process.exit(0);
  } catch (e) {
    logger.error('did not exited cleanly', e);
    process.exit(1);
  }
}

process.on('unhandledRejection', async (err) => {
  logger.error('got unhandledRejection', err);
  shutdown();
});

process.on('SIGINT', async (err) => {
  logger.error('got SIGINT', err);
  shutdown();
});

init();
