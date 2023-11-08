import { Plugin, ServerRegisterOptions } from '@hapi/hapi';
import {
  LiquidityCache as TickLiquidityCache,
  TickLiquidity,
  tickLiquidityCache,
} from '../../storage/sqlite3/db/derived.tick_state/getTickLiquidity';
import {
  LiquidityCache as TokenPairsLiquidityCache,
  TokenPairsLiquidity,
  tokenPairsLiquidityCache,
} from '../../storage/sqlite3/db/derived.tick_state/getTokenPairsLiquidity';

import liquidityTokenRoutes from './token';
import liquidityPairRoutes from './pair';
import liquidityPairsRoutes from './pairs';

export interface Plugins {
  tickLiquidityCache: TickLiquidityCache;
  tokenPairsLiquidityCache: TokenPairsLiquidityCache;
}

export const plugin: Plugin<ServerRegisterOptions> = {
  name: 'liquidity',
  register: async function (server) {
    const pluginContext: Plugins = {
      tickLiquidityCache: server.cache<TickLiquidity>({
        segment: 'tick-liquidity',
        ...tickLiquidityCache,
      }),
      tokenPairsLiquidityCache: server.cache<TokenPairsLiquidity>({
        segment: 'token-pairs-liquidity',
        ...tokenPairsLiquidityCache,
      }),
    };
    server.bind(pluginContext);
    server.route([
      ...liquidityPairsRoutes,
      ...liquidityPairRoutes,
      ...liquidityTokenRoutes,
    ]);
  },
};
