import { mediaTypes } from '@hapi/accept';
import { isEqual, reject } from 'lodash-es';
import logger from './logger';
import { ExtendedResponseJSON } from './cache-query';
import { ExtendedRequest } from 'router';
import { ServerResponse } from 'node:http';

const { NODE_ENV = 'development' } = process.env;

interface BaseRequestPayload {
  params?: Record<string, string>;
  query?: Record<string, string>;
}
type BaseResponsePayload = object;

export type GetData<
  RequestPayload extends BaseRequestPayload,
  ResponsePayload extends BaseResponsePayload
> = (
  request: RequestPayload,
  abortController: AbortSignal,
  previousResponse?: ExtendedResponseJSON<ResponsePayload>
) => Promise<ExtendedResponseJSON<ResponsePayload>>;

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

export function handleResponse<
  RequestPayload extends BaseRequestPayload,
  ResponsePayload extends BaseResponsePayload
>(
  getData: GetData<RequestPayload, ResponsePayload>,
  additionalStreams?: (
    queryParams: RequestPayload['query']
  ) => Record<string, GetData<RequestPayload, ResponsePayload>>
) {
  return async (
    req: ExtendedRequest<RequestPayload['params'], RequestPayload['query']>,
    res: ServerResponse,
    next: (err?: Error) => void
  ) => {
    // construct simple payload of request to pass to handlers
    const reqPayload: RequestPayload = {
      params: { ...req.params },
      query: { ...req.query },
    } as RequestPayload;
    try {
      // detect user abortion of request
      const abortController = new AbortController();
      req.once('close', (reason: unknown) => {
        if (!abortController.signal.aborted) {
          abortController.abort(reason);
        }
      });
      // do SSE streaming if requested
      if (
        // allow HTTP1 streaming in non-production (helps local development)
        (req.httpVersionMajor === 2 || NODE_ENV !== 'production') &&
        // respond to browser `new EventSource()` requests with SSE event streams
        (mediaTypes(req.headers['accept']).includes('text/event-stream') ||
          Object.hasOwn(req.query || {}, 'stream'))
      ) {
        // establish SSE content through headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        // add stream start indication
        res.write(
          formatChunk({
            event: 'stream start',
          })
        );

        const getDataWithLabels = {
          ...additionalStreams?.(req.query),
          [additionalStreams ? 'main' : '']: getData,
        };

        await Promise.all(
          Object.entries(getDataWithLabels).map(async ([label, getData]) => {
            const getLabel = (height?: number) =>
              [
                label ? `label: ${label}` : '',
                height ? `height: ${height}` : '',
              ]
                .filter(Boolean)
                .join(', ');

            // get initial data
            const initialData = await getData(
              reqPayload,
              abortController.signal
            );
            if (initialData.meta) {
              res.write(
                formatChunk({
                  event: 'metadata',
                  id: getLabel(),
                  data: JSON.stringify(initialData.meta),
                })
              );
            }
            res.write(
              formatChunk({
                event: 'data',
                id: getLabel(initialData.height),
                data: JSON.stringify(initialData.data),
              })
            );
            // add stats info if available
            if (initialData.statistics) {
              res.write(
                formatChunk({
                  event: 'statistics',
                  id: getLabel(initialData.height),
                  data: JSON.stringify(initialData.statistics),
                })
              );
            }

            let lastResult = initialData;
            while (!abortController.signal.aborted && !lastResult.isComplete) {
              // wait for next update data change
              try {
                const newResultData = await getData(
                  reqPayload,
                  abortController.signal,
                  lastResult
                );
                // find data updates
                const newRows =
                  !isEqual(lastResult.data, newResultData.data) &&
                  newResultData.data.filter((newRow) => {
                    return !lastResult.data.some((row) => isEqual(row, newRow));
                  });
                // write data chunk if updates are found
                if (newRows && newRows.length > 0) {
                  res.write(
                    formatChunk({
                      event: 'data',
                      id: getLabel(newResultData.height),
                      // send unsent rows only
                      data: JSON.stringify(newRows),
                    })
                  );
                  // add stats info if available
                  if (newResultData.statistics) {
                    res.write(
                      formatChunk({
                        event: 'statistics',
                        id: getLabel(newResultData.height),
                        data: JSON.stringify(newResultData.statistics),
                      })
                    );
                  }
                }
                // send heartbeat data to report changes in source data height
                else if (
                  !isEqual(lastResult.heartbeat, newResultData.heartbeat)
                ) {
                  res.write(
                    formatChunk({
                      event: 'heartbeat',
                      id: getLabel(newResultData.heartbeat),
                    })
                  );
                  // add stats info if available
                  if (newResultData.statistics) {
                    res.write(
                      formatChunk({
                        event: 'statistics',
                        id: getLabel(newResultData.heartbeat),
                        data: JSON.stringify(newResultData.statistics),
                      })
                    );
                  }
                }
                // save new data to compare against
                // note that incremental updates may have 0 rows, in which case
                // they may have 0 height, so pass the last known height along
                lastResult = {
                  ...newResultData,
                  height: newResultData.height || lastResult.height,
                };
                // wait a bit
                await new Promise((resolve) => setTimeout(resolve, 100));
              } catch (err) {
                logger.error(`SSE update error: ${err}`);
                // send error event to user
                if (res.writable) {
                  // send error only if it wasn't an aborted request
                  if (!abortController.signal.aborted) {
                    res.write(
                      formatChunk({
                        event: 'error',
                        data: (err as Error)?.message ?? `${err}`,
                      })
                    );
                  }
                }
                // exit loop, likely getData has failed somehow
                break;
              }
            }
          })
        );

        // cancel request to DB if not yet cancelled
        if (!abortController.signal.aborted) {
          abortController.abort();
        }

        // if the stream has ended there is nothing left to send
        if (res.closed) {
          return;
        }

        // send final message if stream is still open
        if (res.writable) {
          res.write(
            formatChunk({
              event: 'stream end',
            })
          );
        }
        // if data needs to drain then wait for it to drain
        if (res.writableNeedDrain) {
          await new Promise<void>((resolve) => {
            // set timeout
            const timeout = setTimeout(() => {
              logger.error('Was not able to drain SSE data within timeout');
              resolve();
            }, 10000);
            // wait for drain
            res.once('drain', () => {
              clearTimeout(timeout);
              resolve();
            });
          });
        }

        await new Promise<void>((resolve) => {
          try {
            if (res.writable) {
              const timeout = setTimeout(() => {
                reject(new Error('Could not end connection within timeout'));
              }, 3000);
              res.end(() => {
                clearTimeout(timeout);
                resolve();
              });
            } else {
              resolve();
            }
          } catch (e) {
            logger.error('Could not end connection', e);
            return resolve();
          }
        });
      } else {
        const result = await getData(reqPayload, abortController.signal);
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            data: result.data,
            meta: result.meta,
            height: result.height,
            statistics: result.statistics,
          })
        );
      }
      next();
    } catch (err: unknown) {
      logger.error('handle response error', err);
      res.statusCode = 500;
      res.end('An unknown error occurred');
      next(new Error('An unknown error occurred', { cause: err }));
    }
  };
}
