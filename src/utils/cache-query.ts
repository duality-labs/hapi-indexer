import { ResponseJSON } from '@clickhouse/client';
import { Sql } from 'sql-template-tag';

import { client } from './client';
import { inMs, seconds } from './units';
import { toClickHouseSQL } from '../utils/sql';
import logger from './logger';

const { SHOW_STATISTICS = '' } = process.env;

interface CacheEnvelope {
  value: Promise<ResponseJSON>;
  version: number;
  created: number;
  expires: number;
}

interface ResponseOptions<T, U> extends QueryCacheOptions {
  heartbeat?: number;
  getHeight?: (array: T[]) => number;
  getRow?: (value: T, index: number, array: T[]) => U | U[];
  getMetadata?: (metadata: ResponseJSON<T>['meta']) => ResponseJSON<U>['meta'];
  isComplete?: boolean;
}
interface QueryCacheOptions {
  cacheKey?: string;
  cacheVersion?: number;
  cacheTime?: number;
}
export interface ExtendedResponseJSON<T = unknown>
  extends Pick<ResponseJSON<T>, 'data' | 'statistics'> {
  // modification: add more keys to metadata: 'units'
  //   (eg. [{ name: 'volume', 'type': 'number', 'units': 'untrn' }])
  meta?: Array<{ name: string; type: string; units?: string }>;
  // add special block data information
  // - "header": block height from queried data table
  height: number;
  // - "heartbeat": block height from source data table
  heartbeat: number;
  isComplete: boolean;
}

const DEFAULT_CACHE_TIME = 0.2 * seconds * inMs;
const DEFAULT_CACHE_CLEAN_TIME = 5 * seconds * inMs;

const requestCache = new Map<string, CacheEnvelope>();
let requestCacheNextClearTime = Date.now() + DEFAULT_CACHE_CLEAN_TIME;

function checkCache() {
  const now = Date.now();
  const clearedKeys = Array.from(requestCache.entries()).reduce(
    (count, [key, value]) => {
      if (now > value.expires) {
        requestCache.delete(key);
        return count + 1;
      }
      return count;
    },
    0
  );
  logger.debug(
    `Cache size at ${new Date().toISOString()}: ${requestCache.size
      .toFixed(0)
      .padEnd(7, ' ')} (cleared ${clearedKeys} values)`
  );
}

// add overload type: passing "height" is required to return  "height" property
export async function getCachedResponse<
  Row extends object,
  RowResponse extends object = Row
>(
  query: Sql,
  abortSignal: AbortSignal,
  // require both heartbeat and getHeight() to return data frame data height
  options: ResponseOptions<Row, RowResponse> & {
    heartbeat: number;
    getHeight: (array: Row[]) => number;
  }
): Promise<ExtendedResponseJSON<RowResponse>>;
export async function getCachedResponse<
  Row extends object,
  RowResponse extends object = Row
>(
  query: Sql,
  abortSignal: AbortSignal,
  options?: ResponseOptions<Row, RowResponse>
): Promise<Omit<ExtendedResponseJSON<RowResponse>, 'height' | 'heartbeat'>>;
export async function getCachedResponse<
  Row extends object,
  RowResponse extends object = Row
>(
  query: Sql,
  abortSignal: AbortSignal,
  {
    heartbeat,
    getHeight,
    getRow,
    getMetadata,
    isComplete = false,
    cacheKey = JSON.stringify([query.sql, query.values]),
    cacheVersion = 0,
    cacheTime = DEFAULT_CACHE_TIME,
  }: ResponseOptions<Row, RowResponse> = {}
): Promise<ExtendedResponseJSON<RowResponse> | ResponseJSON<RowResponse>> {
  const now = Date.now();
  // check cache later if some time has passed since last cleaning
  if (requestCacheNextClearTime < now) {
    requestCacheNextClearTime = now + DEFAULT_CACHE_CLEAN_TIME;
    setTimeout(checkCache, DEFAULT_CACHE_CLEAN_TIME);
  }
  // get cached value now
  const cachedResponse = requestCache.get(cacheKey);
  // return matching cache request/response or fetch new value
  const response = await (cachedResponse &&
  // item is not expired
  cachedResponse.expires > now &&
  // item is not older than new query cache time
  cachedResponse.created + cacheTime > now &&
  // item is at least the requested version
  cachedResponse.version >= (cacheVersion || 0)
    ? // note: only the query is cached all transformations are applied post-cache
      (cachedResponse.value as Promise<ResponseJSON<Row>>)
    : (function getNewResponse() {
        // create a new request to cache
        const newResponse = {
          value: new Promise<ResponseJSON<Row>>((resolve, reject) => {
            client
              .query({
                ...toClickHouseSQL(query, 'JSON'),
                // allow query to be cancelled
                abort_signal: abortSignal,
              })
              .then((response) => response.json<Row>())
              .then(resolve)
              .catch(reject);
          }),
          version: cacheVersion || 0,
          created: now,
          expires: now + cacheTime,
        };
        requestCache.set(cacheKey, newResponse);
        return newResponse.value;
      })());
  // add heartbeat data to cached response (may not show data to user)
  return {
    heartbeat,
    meta: getMetadata ? getMetadata(response.meta) : response.meta,
    data: getRow
      ? response.data.flatMap<RowResponse>(getRow)
      : // note: return type may be wrong when RowResponse != Row
        (response.data as unknown as RowResponse[]),
    height: getHeight?.(response.data),
    statistics: SHOW_STATISTICS === 'true' ? response.statistics : undefined,
    isComplete,
  };
}
