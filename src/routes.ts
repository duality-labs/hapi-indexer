import {
  ReqRefDefaults,
  Request,
  ResponseToolkit,
  ServerRoute,
} from '@hapi/hapi';
import logger from './logger';
import { client } from './client';

const query: ServerRoute<ReqRefDefaults> = {
  method: 'POST',
  path: '/query',
  handler: async (request: Request, h: ResponseToolkit) => {
    try {
      const payload = request.payload as {
        username?: string;
        password?: string;
        query?: string;
      };
      if (!payload.query) {
        throw new Error(`query not found in: ${JSON.stringify(payload)}`);
      }
      const response = await client.query({
        query: payload.query,
        ...(payload['username'] &&
          payload['password'] && {
            auth: {
              username: payload['username'],
              password: payload['password'],
            },
          }),
      });
      return await response.json();
    } catch (err: unknown) {
      if (err instanceof Error) {
        logger.error(err);
        return h
          .response(`something happened: ${err.message || '?'}`)
          .code(500);
      }
      return h.response('An unknown error occurred').code(500);
    }
  },
};

// add debug route
const debugQuery = {
  method: 'GET',
  path: '/debug/query',
  handler: async (request: Request, h: ResponseToolkit) => {
    try {
      const query = request.query['query'];
      const response = await client.query({
        query,
        ...(request.query['username'] &&
          request.query['password'] && {
            auth: {
              username: request.query['username'],
              password: request.query['password'],
            },
          }),
      });
      return await response.json();
    } catch (err: unknown) {
      if (err instanceof Error) {
        logger.error(err);
        return h
          .response(`something happened: ${err.message || '?'}`)
          .code(500);
      }
      return h.response('An unknown error occurred').code(500);
    }
  },
};

// add debug route
const debugHeight = {
  method: 'GET',
  path: '/debug/height',
  handler: async (request: Request, h: ResponseToolkit) => {
    try {
      const response = await client.query({
        query:
          'SELECT max(height) as raw_block_results_height from raw_block_results',
        ...(request.query['username'] &&
          request.query['password'] && {
            auth: {
              username: request.query['username'],
              password: request.query['password'],
            },
          }),
      });
      return await response.json();
    } catch (err: unknown) {
      if (err instanceof Error) {
        logger.error(err);
        return h
          .response(`something happened: ${err.message || '?'}`)
          .code(500);
      }
      return h.response('An unknown error occurred').code(500);
    }
  },
};

// add debug route
const debugSSE = {
  method: 'GET',
  path: '/debug/sse',
  handler: async (request: Request, h: ResponseToolkit) => {
    function formatChunk({
      event,
      id,
      data = '',
    }: {
      event?: string;
      id?: string | number;
      data?: string;
    }): string {
      return [
        event !== undefined && `event: ${event}`,
        id !== undefined && `id: ${id}`,
        data !== undefined && `data: ${data}`,
        // add an extra newline for better viewing of concatenated stream
        '\n',
      ]
        .filter(Boolean)
        .join('\n');
    }

    try {
      const { req, res } = request.raw;
      const canUseSSE = req.httpVersionMajor === 2;

      if (canUseSSE) {
        // establish SSE content through headers
        res.setHeader('Content-Type', 'text/event-stream');
        if (request.info.cors.isOriginMatch && request.headers['origin']) {
          res.setHeader(
            'Access-Control-Allow-Origin',
            request.headers['origin']
          );
        }
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        // add shape data
        res.write(
          formatChunk({
            event: 'start stream',
          })
        );

        let aborted = false;
        req.once('close', () => (aborted = true));
        let lastHeight = '';
        while (!aborted) {
          // wait for next block
          try {
            const response = await client.query({
              query: 'SELECT max(height) as height from raw_block_results',
              ...(request.query['username'] &&
                request.query['password'] && {
                  auth: {
                    username: request.query['username'],
                    password: request.query['password'],
                  },
                }),
            });
            const json = await response.json();
            logger.info(JSON.stringify(json, null, 2));
            const height =
              (json.data as { height: string }[]).at(0)?.height ?? '';
            logger.info(height);
            if (height !== lastHeight) {
              res.write(
                formatChunk({
                  event: !lastHeight
                    ? 'current block height'
                    : 'new block height',
                  data: height,
                })
              );
            }
            lastHeight = height;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } catch (err) {
            logger.error(`SSE update error: ${err}`);
            // send error event to user
            if (res.writable) {
              res.write(
                formatChunk({
                  event: 'error',
                  data: (err as Error)?.message ?? `${err}`,
                })
              );
            }
            // exit loop, likely getData has failed somehow
            break;
          }
        }

        // wait a tick to be sure that "end" in in the queue
        await new Promise<void>((resolve) =>
          setTimeout(() => {
            !res.destroyed && res.destroy();
            resolve();
          }, 0)
        );
        // exit
        res.destroy();
      } else {
        return h.response('cannot return an SSE stream').code(500);
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        logger.error(err);
        return h
          .response(`something happened: ${err.message || '?'}`)
          .code(500);
      }
      return h.response('An unknown error occurred').code(500);
    }
  },
};

export const routes = [
  // add development only paths
  ...(process.env.NODE_ENV === 'development'
    ? [debugQuery, debugHeight, debugSSE]
    : []),
  // add production proxy of query body request to DB
  query,
];
