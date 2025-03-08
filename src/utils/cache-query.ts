import { ResponseJSON } from '@clickhouse/client';
import { Sql } from 'sql-template-tag';

import { client } from './client';
import { inMs, seconds } from './units';
import { toClickHouseSQL } from '../utils/sql';

interface CacheEnvelope {
  value: Promise<ResponseJSON>;
  version: number;
  created: number;
  expires: number;
}

export interface QueryCacheOptions<T> {
  heartbeat?: number;
  getHeight?: (array: T[]) => number;
  getRow?: (value: T, index: number, array: T[]) => T;
  getMetadata?: (metadata: ResponseJSON<T>['meta']) => ResponseJSON<T>['meta'];
  cacheKey?: string;
  cacheVersion?: number;
  cacheTime?: number;
}
export interface ExtendedResponseJSON<T = unknown>
  extends Omit<ResponseJSON<T>, 'meta'> {
  // modification: add more keys to metadata: 'units'
  //   (eg. [{ name: 'volume', 'type': 'number', 'units': 'untrn' }])
  meta?: Array<{ name: string; type: string; units?: string }>;
  // add special block data information
  // - "header": block height from queried data table
  height: number;
  // - "heartbeat": block height from source data table
  heartbeat: number;
}

const DEFAULT_CACHE_TIME = 0.2 * seconds * inMs;

const requestCache = new Map<string, CacheEnvelope>();

// add overload type: passing "height" is required to return  "height" property
export async function getCachedResponse<T>(
  query: Sql,
  abortSignal: AbortSignal,
  // require both heartbeat and getHeight() to return data frame data height
  options: QueryCacheOptions<T> & {
    heartbeat: number;
    getHeight: (array: T[]) => number;
  }
): Promise<ExtendedResponseJSON<T>>;
export async function getCachedResponse<T>(
  query: Sql,
  abortSignal: AbortSignal,
  options?: QueryCacheOptions<T>
): Promise<Omit<ExtendedResponseJSON<T>, 'height' | 'heartbeat'>>;
export async function getCachedResponse<T>(
  query: Sql,
  abortSignal: AbortSignal,
  {
    heartbeat,
    getHeight,
    getRow,
    getMetadata,
    cacheKey = JSON.stringify([query.sql, query.values]),
    cacheVersion = 0,
    cacheTime = DEFAULT_CACHE_TIME,
  }: QueryCacheOptions<T> = {}
): Promise<ExtendedResponseJSON<T> | ResponseJSON<T>> {
  const cachedResponse = requestCache.get(cacheKey);
  const now = Date.now();
  // return matching cache request/response
  if (
    cachedResponse &&
    // item is not expired
    cachedResponse.expires > now &&
    // item is not older than new query cache time
    cachedResponse.created + cacheTime > now &&
    // item is at least the requested version
    cachedResponse.version >= (cacheVersion || 0)
  ) {
    const value = (await cachedResponse.value) as Omit<
      ExtendedResponseJSON<T>,
      'height'
    >;
    // add heartbeat data to cached response (may not show data to user)
    return heartbeat ? { ...value, heartbeat } : value;
  }
  // remove the old version request from the cache
  if (cachedResponse) {
    requestCache.delete(cacheKey);
  }

  // create a new request to cache
  const newResponse = {
    value: new Promise<
      | ExtendedResponseJSON<T>
      | Omit<ExtendedResponseJSON<T>, 'height' | 'heartbeat'>
    >((resolve, reject) => {
      client
        .query<'JSON'>({
          ...toClickHouseSQL(query),
          // allow query to be cancelled
          abort_signal: abortSignal,
        })
        .then((response) => response.json<T>())
        .then((result) =>
          resolve({
            ...result,
            meta: getMetadata ? getMetadata(result.meta) : result.meta,
            data: getRow ? result.data.map(getRow) : result.data,
            height: getHeight?.(result.data),
          })
        )
        .catch(reject);
    }),
    version: cacheVersion || 0,
    created: now,
    expires: now + cacheTime,
  };
  requestCache.set(cacheKey, newResponse);
  return newResponse.value;
}
