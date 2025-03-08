import { ResponseJSON } from '@clickhouse/client';
import { client } from './client';
import { inMs, seconds } from '../utils/time';
import { Sql, toClickHouseSQL } from '../utils/sql';

interface CacheEnvelope {
  value: Promise<ResponseJSON>;
  version: number;
  created: number;
  expires: number;
}

export interface QueryCacheOptions<T> {
  height?: number;
  getHeight?: (array: T[]) => string | undefined;
  getRow?: (value: T, index: number, array: T[]) => T;
  getMetadata?: (metadata: ResponseJSON<T>['meta']) => ResponseJSON<T>['meta'];
  cacheKey?: string;
  cacheVersion?: number;
  cacheTime?: number;
}
const DEFAULT_CACHE_TIME = 0.2 * seconds * inMs;

const requestCache = new Map<string, CacheEnvelope>();

export async function getCachedResponse<T>(
  query: Sql,
  abortSignal: AbortSignal,
  {
    height,
    getHeight,
    getRow,
    getMetadata,
    cacheKey = JSON.stringify([query.sql, query.values]),
    cacheVersion = 0,
    cacheTime = DEFAULT_CACHE_TIME,
  }: QueryCacheOptions<T> = {}
): Promise<ResponseJSON<T>> {
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
    const value = (await cachedResponse.value) as ResponseJSON<T>;
    return height ? { ...value, query_id: height.toFixed(0) } : value;
  }
  // remove the old version request from the cache
  if (cachedResponse) {
    requestCache.delete(cacheKey);
  }

  // create a new request to cache
  const newResponse = {
    value: new Promise<ResponseJSON<T>>((resolve, reject) => {
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
            query_id: getHeight?.(result.data) ?? result.query_id,
          })
        )
        .catch(reject);
    }),
    version: cacheVersion || 0,
    created: now,
    expires: now + cacheTime,
  };
  requestCache.set(cacheKey, newResponse);
  const value = await newResponse.value;
  return height ? { ...value, query_id: height.toFixed(0) } : value;
}
