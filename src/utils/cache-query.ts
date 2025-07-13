import { ClickHouseSettings, ResponseJSON } from '@clickhouse/client';
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
  timestamp?: string;
  getHeight?: (array: T[]) => number;
  getRow?: (value: T, index: number, array: T[]) => U | U[];
  getMetadata?: (metadata: ResponseJSON<T>['meta']) => ResponseJSON<U>['meta'];
  isComplete?: boolean;
  showStatistics?: boolean;
  clickhouseSettings?: ClickHouseSettings;
}
interface QueryCacheOptions {
  cacheKey?: string;
  cacheVersion?: number;
  cacheTime?: number;
  // how long to allow data to be used after it is stored
  staleTimeMax?: number;
  // how long before new data can be generated it stale data was returned
  staleTimeMin?: number;
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
  timestamp: string;
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
    timestamp: string;
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
): Promise<ExtendedResponseJSON<RowResponse>>;
export async function getCachedResponse<
  Row extends object,
  RowResponse extends object = Row
>(
  query: Sql,
  abortSignal: AbortSignal,
  {
    heartbeat,
    timestamp,
    getHeight,
    getRow,
    getMetadata,
    isComplete = false,
    cacheKey = JSON.stringify([query.sql, query.values]),
    cacheVersion = 0,
    cacheTime = DEFAULT_CACHE_TIME,
    staleTimeMax = 0,
    staleTimeMin = 0,
    showStatistics = SHOW_STATISTICS === 'true',
    clickhouseSettings,
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

  const isCurrent = {
    byExpiryTime:
      cachedResponse &&
      // item is not expired
      cachedResponse.expires > now &&
      // item is not older than new query cache time
      cachedResponse.created + cacheTime > now,
    byStaleTimeMin:
      cachedResponse &&
      // item is not older than new query stale time (min)
      cachedResponse.created + staleTimeMin > now,
    byStaleTimeMax:
      cachedResponse &&
      // item is not older than new query stale time (max)
      cachedResponse.created + staleTimeMax > now,
    byVersion: cachedResponse && cachedResponse.version >= (cacheVersion || 0),
  };

  const response = await (cachedResponse &&
  isCurrent.byExpiryTime &&
  (isCurrent.byStaleTimeMax || isCurrent.byVersion)
    ? // note: only the query is cached all transformations are applied post-cache
      (cachedResponse.value as Promise<ResponseJSON<Row>>)
    : getNewResponse(abortSignal));

  // if the returned value is a stale value and a newer version exists
  // and enough time has passed to generate a newer version
  if (
    cachedResponse &&
    isCurrent.byExpiryTime &&
    isCurrent.byStaleTimeMax &&
    !isCurrent.byVersion &&
    !isCurrent.byStaleTimeMin
  ) {
    // do not pass abort signal to possibly long-running async request
    getNewResponse(undefined)
      .then(() => {
        logger.info('Generated new data from stale data request');
      })
      .catch((e) => {
        logger.error('Generated new data from stale data request error', e);
      });
  }

  // add heartbeat data to cached response (may not show data to user)
  return {
    heartbeat,
    timestamp,
    meta: getMetadata ? getMetadata(response.meta) : response.meta,
    data: getRow
      ? response.data.flatMap<RowResponse>(getRow)
      : // note: return type may be wrong when RowResponse != Row
        (response.data as unknown as RowResponse[]),
    height: getHeight?.(response.data),
    statistics: showStatistics ? response.statistics : undefined,
    isComplete,
  };

  function getNewResponse(abortSignal: AbortSignal | undefined) {
    // create a new request to cache
    const newResponse = {
      value: new Promise<ResponseJSON<Row>>((resolve, reject) => {
        client
          .query({
            ...toClickHouseSQL(query, 'JSON'),
            // allow query to be cancelled
            abort_signal: abortSignal,
            // add settings if defined
            clickhouse_settings: clickhouseSettings,
          })
          .then((response) => response.json<Row>())
          .then(resolve)
          .catch((err) => {
            // remove promise from cache immediately
            // new requests should try for a new result
            requestCache.delete(cacheKey);
            reject(err);
          });
      }),
      version: cacheVersion || 0,
      created: now,
      expires: now + cacheTime,
    };
    requestCache.set(cacheKey, newResponse);
    return newResponse.value;
  }
}
