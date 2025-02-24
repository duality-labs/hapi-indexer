import { ResponseJSON, ResultSet } from '@clickhouse/client';
import { client } from '../client';
import { hours } from '../utils/time';
import { Sql, toClickHouseSQL } from '../utils/sql';

interface CacheEnvelope {
  value: Promise<ResultSet<'JSON'>>;
  version: number;
  created: number;
  expires: number;
}

export interface QueryCacheOptions {
  cacheKey?: string;
  cacheVersion?: number;
  cacheTime?: number;
}
const DEFAULT_CACHE_TIME = 1 * hours;

const requestCache = new Map<string, CacheEnvelope>();

export async function getCachedResponse<T>(
  query: Sql,
  {
    cacheKey = JSON.stringify([query.sql, query.values]),
    cacheVersion = 0,
    cacheTime = DEFAULT_CACHE_TIME,
  }: QueryCacheOptions = {}
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
    cachedResponse.version >= cacheVersion
  ) {
    const response = await cachedResponse.value;
    return await response.json<T>();
  }
  // remove the old version request from the cache
  if (cachedResponse) {
    requestCache.delete(cacheKey);
  }

  // create a new request to cache
  const newResponse = {
    value: client.query(toClickHouseSQL(query)),
    created: now,
    version: cacheVersion,
    expires: now + cacheTime,
  };
  requestCache.set(cacheKey, newResponse);
  const response = await newResponse.value;
  return await response.json<T>();
}
