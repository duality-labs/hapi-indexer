import { Plugin, ServerRegisterOptions } from '@hapi/hapi';
import {
  LiquidityCache,
  TickLiquidity,
  tickLiquidityCache,
} from '../../storage/sqlite3/db/derived.tick_state/getTickLiquidity';

import liquidityTokenRoutes from './token';
import liquidityPairRoutes from './pair';

export interface Plugins {
  tickLiquidityCache: LiquidityCache;
}

export const plugin: Plugin<ServerRegisterOptions> = {
  name: 'liquidity',
  register: async function (server) {
    const pluginContext: Plugins = {
      tickLiquidityCache: server.cache<TickLiquidity>({
        segment: 'tick-liquidity',
        ...tickLiquidityCache,
      }),
    };
    server.bind(pluginContext);
    server.route([...liquidityPairRoutes, ...liquidityTokenRoutes]);
  },
};
