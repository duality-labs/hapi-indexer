import { Plugin, ServerRegisterOptions } from '@hapi/hapi';
import {
  LiquidityCache as TickLiquidityCache,
  TickLiquidity,
  tickLiquidityCache,
} from '../../storage/sqlite3/db/derived.tick_state/getTickLiquidity';
import {
  LiquidityCache as TokenPairsLiquidityCache,
  TokensVolumeTableRow,
  tokenPairsLiquidityCache,
} from '../../storage/sqlite3/db/derived.tick_state/getTokenPairsLiquidity';

import liquidityTokenRoutes from './token';
import liquidityPairRoutes from './pair';
import liquidityPairsRoutes from './pairs';
import { CachedTokenPricesPluginContext } from '../../plugins/cached-token-prices';

export interface Plugins {
  tickLiquidityCache: TickLiquidityCache;
  tokenPairsLiquidityCache: TokenPairsLiquidityCache;
  cachedTokenPrices: CachedTokenPricesPluginContext['cachedTokenPrices'];
}

export const plugin: Plugin<ServerRegisterOptions> = {
  name: 'liquidity',
  register: async function (server) {
    const pluginContext: Plugins = {
      tickLiquidityCache: server.cache<TickLiquidity>({
        segment: 'tick-liquidity',
        ...tickLiquidityCache,
      }),
      tokenPairsLiquidityCache: server.cache<TokensVolumeTableRow[]>({
        segment: 'token-pairs-liquidity',
        ...tokenPairsLiquidityCache,
      }),
      // add global cache to the plugin context
      cachedTokenPrices: (server.plugins as CachedTokenPricesPluginContext)
        .cachedTokenPrices,
    };
    server.bind(pluginContext);
    server.route([
      ...liquidityPairsRoutes,
      ...liquidityPairRoutes,
      ...liquidityTokenRoutes,
    ]);
  },
};
