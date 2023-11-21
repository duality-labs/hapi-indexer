import { Plugin, ServerRegisterOptions } from '@hapi/hapi';
import { GlobalPlugins } from '../../plugins';

import {
  PairPriceCache,
  PairPriceTimeseries,
  pairPriceCache,
} from '../../storage/sqlite3/db/derived.tx_price_data/getPrice';

import {
  TotalVolumeCache,
  TotalVolumeTimeseries,
  totalVolumeCache,
} from '../../storage/sqlite3/db/derived.tx_volume_data/getTotalVolume';

import {
  SwapVolumeCache,
  SwapVolumeTimeseries,
  swapVolumeCache,
} from '../../storage/sqlite3/db/event.TickUpdate/getSwapVolume';

import priceRoutes from './price';
import volumeRoutes from './volume';

export interface Plugins extends GlobalPlugins {
  pairPriceCache: PairPriceCache;
  totalVolumeCache: TotalVolumeCache;
  swapVolumeCache: SwapVolumeCache;
}

export const plugin: Plugin<ServerRegisterOptions> = {
  name: 'timeseries',
  register: async function (server) {
    const pluginContext: Plugins = {
      // copy all global server plugins into context
      ...(server.plugins as Plugins),
      // add specific caches
      pairPriceCache: server.cache<PairPriceTimeseries>({
        segment: 'pair-price-timeseries',
        ...pairPriceCache,
      }),
      totalVolumeCache: server.cache<TotalVolumeTimeseries>({
        segment: 'total-volume-timeseries',
        ...totalVolumeCache,
      }),
      swapVolumeCache: server.cache<SwapVolumeTimeseries>({
        segment: 'swap-volume-timeseries',
        ...swapVolumeCache,
      }),
    };
    server.bind(pluginContext);
    server.route([...priceRoutes, ...volumeRoutes]);
  },
};
