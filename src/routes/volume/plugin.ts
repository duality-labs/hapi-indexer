import { Plugin, ServerRegisterOptions } from '@hapi/hapi';
import { GlobalPlugins } from '../../plugins';

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

import volumeRoutes from './volume';

export interface Plugins extends GlobalPlugins {
  totalVolumeCache: TotalVolumeCache;
  swapVolumeCache: SwapVolumeCache;
}

export const plugin: Plugin<ServerRegisterOptions> = {
  name: 'volume-routes',
  register: async function (server) {
    const pluginContext: Plugins = {
      // copy all global server plugins into context
      ...(server.plugins as Plugins),
      // add specific caches
      totalVolumeCache: server.cache<TotalVolumeTimeseries>({
        segment: 'total-volume',
        ...totalVolumeCache,
      }),
      swapVolumeCache: server.cache<SwapVolumeTimeseries>({
        segment: 'swap-volume',
        ...swapVolumeCache,
      }),
    };
    server.bind(pluginContext);
    server.route([...volumeRoutes]);
  },
};
