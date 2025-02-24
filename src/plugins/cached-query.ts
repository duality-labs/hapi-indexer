import { ResponseJSON, ResultSet } from '@clickhouse/client';
import { Plugin, ServerRegisterOptions } from '@hapi/hapi';
import { client } from '../client';
import { hours } from '../utils/time';

const name = 'cache' as const;
export interface PluginContext {
  [name]: {
    getCachedResponse: <T>(
      cacheKey: string,
      cacheOptions: QueryCacheOptions
    ) => Promise<ResponseJSON<T>>;
  };
}

interface CacheEnvelope {
  value: Promise<ResultSet<'JSON'>>;
  version: number;
  created: number;
  expires: number;
}

interface QueryCacheOptions {
  cacheKey?: string;
  cacheVersion?: number;
  cacheTime?: number;
}
const DEFAULT_CACHE_TIME = 1 * hours;

const requestCache = new Map<string, CacheEnvelope>();
export const plugin: Plugin<ServerRegisterOptions> = {
  name,
  register: async function (server) {
    // add cache method into response context
    const pluginContext: PluginContext[typeof name] = {
      getCachedResponse: async <T>(
        query: string,
        {
          cacheKey = query,
          cacheVersion = 0,
          cacheTime = DEFAULT_CACHE_TIME,
        }: QueryCacheOptions = {}
      ) => {
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
          value: client.query({ query }),
          created: now,
          version: cacheVersion,
          expires: now + cacheTime,
        };
        requestCache.set(cacheKey, newResponse);
        const response = await newResponse.value;
        return await response.json<T>();
      },
    };
    // add plugin context methods to plugin under server.plugin[pluginName][key]
    server.expose(pluginContext);
  },
};
