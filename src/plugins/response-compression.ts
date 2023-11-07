import { Policy, PolicyOptions } from '@hapi/catbox';
import { Plugin, ResponseObject, ServerRegisterOptions } from '@hapi/hapi';

const name = 'compressResponse' as const;
export interface PluginContext {
  [name]: {
    getCachedValue: (cacheKey: string, data: unknown) => Promise<string>;
    withKey: (cacheKey: string) => (data: ResponseObject) => Promise<string>;
  };
}

export const plugin: Plugin<ServerRegisterOptions> = {
  name,
  register: async function (server) {
    // create cache
    const responseCache: Policy<
      string,
      PolicyOptions<string>
    > = server.cache<string>({ segment: 'compressed-responses' });
    // add cache method into response context
    const pluginContext: PluginContext['compressResponse'] = {
      getCachedValue: async (cacheKey: string, data: unknown) => {
        let cachedResponse = await responseCache.get(cacheKey);
        if (!cachedResponse) {
          cachedResponse = JSON.stringify(data).replace(
            ...losslessScientificNotationNumberReplacer
          );
          // set only briefly to handle multiple requests waiting for same data
          // todo: save for longer and add a listener to remove the cache when
          //       the next block height resolves
          await responseCache.set(cacheKey, cachedResponse, 100);
        }
        return cachedResponse;
      },
      withKey: (cacheKey: string) => {
        return async (data: ResponseObject) =>
          pluginContext.getCachedValue(cacheKey, data.source);
      },
    };
    // add plugin context methods to plugin under server.plugin[pluginName][key]
    server.expose(pluginContext);
  },
};

const losslessScientificNotationNumberReplacer: [
  RegExp,
  (match: string, m1: string, m2: string, m3: string) => string
] = [
  /(\d)(\d{0,2}[1-9])?(0{6,})/g,
  (
    match: string,
    firstDigit: string,
    trailingDigits: string,
    zeros: string
  ) => {
    return trailingDigits
      ? `${firstDigit}.${trailingDigits}e${match.length - 1}`
      : `${firstDigit}e${zeros.length}`;
  },
];
