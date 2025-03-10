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

export interface QueryCacheOptions<T, U> {
  heartbeat?: number;
  getHeight?: (array: T[]) => number;
  getRow?: (value: T, index: number, array: T[]) => U | U[];
  getMetadata?: (metadata: ResponseJSON<T>['meta']) => ResponseJSON<U>['meta'];
  isComplete?: boolean;
  cacheKey?: string;
  cacheVersion?: number;
  cacheTime?: number;
}
export interface ExtendedResponseJSON<T = unknown>
  extends Pick<ResponseJSON<T>, 'data'> {
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

const requestCache = new Map<string, CacheEnvelope>();

// add overload type: passing "height" is required to return  "height" property
export async function getCachedResponse<Row, RowResponse = Row>(
  query: Sql,
  abortSignal: AbortSignal,
  // require both heartbeat and getHeight() to return data frame data height
  options: QueryCacheOptions<Row, RowResponse> & {
    heartbeat: number;
    getHeight: (array: Row[]) => number;
  }
): Promise<ExtendedResponseJSON<RowResponse>>;
export async function getCachedResponse<Row, RowResponse = Row>(
  query: Sql,
  abortSignal: AbortSignal,
  options?: QueryCacheOptions<Row, RowResponse>
): Promise<Omit<ExtendedResponseJSON<RowResponse>, 'height' | 'heartbeat'>>;
export async function getCachedResponse<Row, RowResponse extends Row = Row>(
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
  }: QueryCacheOptions<Row, RowResponse> = {}
): Promise<ExtendedResponseJSON<RowResponse> | ResponseJSON<RowResponse>> {
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
      ExtendedResponseJSON<RowResponse>,
      'height'
    >;
    // add heartbeat data to cached response (may not show data to user)
    return heartbeat ? { ...value, heartbeat, isComplete } : value;
  }
  // remove the old version request from the cache
  if (cachedResponse) {
    requestCache.delete(cacheKey);
  }

  // create a new request to cache
  const newResponse = {
    value: new Promise<
      | ExtendedResponseJSON<RowResponse>
      | Omit<ExtendedResponseJSON<RowResponse>, 'height' | 'heartbeat'>
    >((resolve, reject) => {
      client
        .query({
          ...toClickHouseSQL(query, 'JSON'),
          // allow query to be cancelled
          abort_signal: abortSignal,
        })
        .then((response) => response.json<Row>())
        .then((result) =>
          resolve({
            ...result,
            meta: getMetadata ? getMetadata(result.meta) : result.meta,
            data: getRow
              ? result.data.flatMap(getRow)
              : // note: return type may be wrong when RowResponse != Row
                (result.data as RowResponse[]),
            height: getHeight?.(result.data),
            isComplete,
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
  // add heartbeat data to cached response (may not show data to user)
  return heartbeat ? { ...value, heartbeat, isComplete } : value;
}
