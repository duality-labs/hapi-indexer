import { Plugin, ServerRegisterOptions } from '@hapi/hapi';
import {
  CoinGeckoSimplePriceResponse,
  CoinPriceCache,
  coinPriceCache,
} from '../storage/sqlite3/ingest/utils/coingecko';

export interface PluginContext {
  get: () => Promise<CoinGeckoSimplePriceResponse>;
}
export interface CompressResponsePluginContext {
  cachedTokenPrices?: PluginContext;
}

export const name = 'cached-token-prices';
export const plugin: Plugin<ServerRegisterOptions> = {
  name,
  register: async function (server) {
    // create cache
    const cache: CoinPriceCache = server.cache({
      segment: 'token-prices',
      ...coinPriceCache,
    });
    // add cache method into response context
    const pluginContext: PluginContext = {
      get: async () => {
        return (await cache.get('')) ?? {};
      },
    };
    // add plugin context methods to plugin under server.plugin[pluginName][key]
    server.expose(pluginContext);
  },
};
