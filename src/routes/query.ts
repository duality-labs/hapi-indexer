import {
  ReqRefDefaults,
  Request,
  ResponseToolkit,
  ServerRoute,
} from '@hapi/hapi';
import { mediaTypes } from '@hapi/accept';
import logger from '../logger';
import { client } from '../client';

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

export const route: ServerRoute<ReqRefDefaults> = {
  method: 'POST',
  path: '/query',
  handler: async (request: Request, h: ResponseToolkit) => {
    try {
      const payload = request.payload as {
        username?: string;
        password?: string;
        query?: string;
        format?: 'JSON';
        stream?: {
          key?: string;
          query?: string;
          format?: 'JSON';
          delayMs?: number;
        };
      };
      if (!payload?.query) {
        throw new Error(`query not found in: ${JSON.stringify(payload)}`);
      }
      // do SSE streaming if requested
      if (
        payload.stream &&
        payload.stream.key &&
        payload.stream.query &&
        request.raw.req.httpVersionMajor === 2 &&
        // respond to browser `new EventSource()` requests with SSE event streams
        mediaTypes(request.headers['accept']).includes('text/event-stream')
      ) {
        const { req, res } = request.raw;
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
        // add stream start indication
        res.write(
          formatChunk({
            event: 'start stream',
          })
        );

        let aborted = false;
        req.once('close', () => (aborted = true));

        // get initial data
        const response = await client.query<'JSON'>({
          query: payload.query,
          format: payload.format ?? 'JSON',
          ...(payload['username'] &&
            payload['password'] && {
              auth: {
                username: payload['username'],
                password: payload['password'],
              },
            }),
        });
        const initialData = await response.json();
        res.write(
          formatChunk({
            event: 'initial data',
            data: JSON.stringify(initialData.data),
          })
        );

        let lastCacheKey = '';
        let lastResultData: unknown[] = [];
        while (!aborted) {
          // wait for next update data change
          try {
            // todo: cache to win
            const cacheKeyResult = await client.query({
              query: payload.stream.key,
              format: payload.stream.format || 'JSON',
              ...(request.query['username'] &&
                request.query['password'] && {
                  auth: {
                    username: request.query['username'],
                    password: request.query['password'],
                  },
                }),
            });
            const cacheKeyResultJSON = await cacheKeyResult.json();
            const newCacheKey = JSON.stringify(cacheKeyResultJSON.data);
            if (lastCacheKey !== newCacheKey) {
              // todo: cache to win
              const streamPartResult = await client.query({
                query: payload.stream.query,
                format: payload.stream.format || 'JSON',
                query_params: {
                  var_cache_key: newCacheKey,
                  var_last_result: JSON.stringify(lastResultData),
                },
                ...(request.query['username'] &&
                  request.query['password'] && {
                    auth: {
                      username: request.query['username'],
                      password: request.query['password'],
                    },
                  }),
              });
              const streamPartResultJSON = await streamPartResult.json();
              res.write(
                formatChunk({
                  event: 'new data',
                  data: JSON.stringify(streamPartResultJSON.data),
                })
              );
              // save new key
              lastCacheKey = newCacheKey;
              lastResultData = streamPartResultJSON.data;
            }
            await new Promise((resolve) =>
              setTimeout(resolve, payload.stream?.delayMs ?? 1000)
            );
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
        return res.destroy();
      }

      const response = await client.query({
        query: payload.query,
        format: payload.format ?? 'JSON',
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
