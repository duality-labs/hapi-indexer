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

export interface QueryCacheOptions {
  cacheKey?: string;
  cacheVersion?: number;
  cacheTime?: number;
}
const DEFAULT_CACHE_TIME = 0.2 * seconds * inMs;

const requestCache = new Map<string, CacheEnvelope>();

export async function getCachedResponse<T>(
  query: Sql,
  {
    cacheKey = JSON.stringify([query.sql, query.values]),
    cacheVersion = 0,
    cacheTime = DEFAULT_CACHE_TIME,
  }: QueryCacheOptions = {},
  queryHeight?: number
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
    return queryHeight ? { query_id: queryHeight.toFixed(0), ...value } : value;
  }
  // remove the old version request from the cache
  if (cachedResponse) {
    requestCache.delete(cacheKey);
  }

  // create a new request to cache
  const newResponse = {
    value: new Promise<ResponseJSON<T>>((resolve, reject) => {
      client
        .query<'JSON'>(toClickHouseSQL(query))
        .then((response) => response.json<T>())
        .then((result) => resolve(result))
        .catch(reject);
    }),
    version: cacheVersion || 0,
    created: now,
    expires: now + cacheTime,
  };
  requestCache.set(cacheKey, newResponse);
  const value = await newResponse.value;
  return queryHeight ? { query_id: queryHeight.toFixed(0), ...value } : value;
}
