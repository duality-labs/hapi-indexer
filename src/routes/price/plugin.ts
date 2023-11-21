import { Plugin, ServerRegisterOptions } from '@hapi/hapi';
import { GlobalPlugins } from '../../plugins';

import {
  PairPriceCache,
  PairPriceTimeseries,
  pairPriceCache,
} from '../../storage/sqlite3/db/derived.tx_price_data/getPrice';

import priceRoutes from './price';

export interface Plugins extends GlobalPlugins {
  pairPriceCache: PairPriceCache;
}

export const plugin: Plugin<ServerRegisterOptions> = {
  name: 'price-routes',
  register: async function (server) {
    const pluginContext: Plugins = {
      // copy all global server plugins into context
      ...(server.plugins as Plugins),
      // add specific caches
      pairPriceCache: server.cache<PairPriceTimeseries>({
        segment: 'pair-price',
        ...pairPriceCache,
      }),
    };
    server.bind(pluginContext);
    server.route([...priceRoutes]);
  },
};
