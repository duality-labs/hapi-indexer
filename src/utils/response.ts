import { ResponseJSON } from '@clickhouse/client';
import { mediaTypes } from '@hapi/accept';
import { ReqRef, ReqRefDefaults, Request, ResponseToolkit } from '@hapi/hapi';
import { isEqual } from 'lodash-es';
import defaultLogger from './logger';

export function formatChunk({
  event,
  id,
  data = !event && !id ? '' : undefined,
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

export function handleResponse<T extends ReqRef = ReqRefDefaults>(
  getData: (
    request: Request<T>,
    abortController: AbortSignal
  ) => Promise<ResponseJSON>
) {
  return async (request: Request<T>, h: ResponseToolkit) => {
    try {
      // detect user abortion of request
      const abortController = new AbortController();
      request.raw.req.once('close', () => abortController.abort());
      // do SSE streaming if requested
      if (
        request.raw.req.httpVersionMajor === 2 &&
        // respond to browser `new EventSource()` requests with SSE event streams
        (mediaTypes(request.headers['accept']).includes('text/event-stream') ||
          Object.hasOwn(request.query, 'stream'))
      ) {
        const res = request.raw.res;
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

        // get initial data
        const initialData = await getData(request, abortController.signal);
        if (initialData.meta) {
          res.write(
            formatChunk({
              event: 'metadata',
              data: JSON.stringify(initialData.meta),
            })
          );
        }
        res.write(
          formatChunk({
            event: 'data',
            id: `height: ${initialData.query_id}`,
            data: JSON.stringify(initialData.data),
          })
        );

        let lastResult = initialData;
        while (!abortController.signal.aborted) {
          // wait for next update data change
          try {
            const newResultData = await getData(
              request,
              abortController.signal
            );
            if (!isEqual(lastResult.data, newResultData.data)) {
              res.write(
                formatChunk({
                  event: 'data',
                  id: `height: ${newResultData.query_id}`,
                  // send unsent rows only
                  data: JSON.stringify(
                    newResultData.data.filter((newRow) => {
                      return !lastResult.data.some((row) =>
                        isEqual(row, newRow)
                      );
                    })
                  ),
                })
              );
            } else if (!isEqual(lastResult.query_id, newResultData.query_id)) {
              res.write(
                formatChunk({
                  event: 'heartbeat',
                  id: `height: ${newResultData.query_id}`,
                })
              );
            }
            // save new data to compare against
            lastResult = newResultData;
            // wait a bit
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch (err) {
            defaultLogger.error(`SSE update error: ${err}`);
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
      return getData(request, abortController.signal);
    } catch (err: unknown) {
      if (err instanceof Error) {
        defaultLogger.error(err);
        return h
          .response(`something happened: ${err.message || '?'}`)
          .code(500);
      }
      return h.response('An unknown error occurred').code(500);
    }
  };
}
