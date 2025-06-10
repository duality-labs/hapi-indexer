import Router from 'router';
import * as debugRoutes from './_debug';
import { route as dexLiquidityRoute } from './dex/liquidity';
import { route as dexPairsRoute } from './dex/pairs';
import { route as dexPriceRoute } from './dex/price';
import { route as dexSwapVolumeRoute } from './dex/swap-volume';
import { route as dexTradesRoute } from './dex/trades';
import { route as dexTvlRoute } from './dex/tvl';
import { route as slinkyPriceRoute } from './slinky/price';
import { route as vaultsRoute } from './vaults';
import { route as vaultsSharesRoute } from './vaults/shares';
import { route as vaultsPnlRoute } from './vaults/pnl';
import { route as vaultsUserPnlRoute } from './vaults/user/pnl';
import { route as vaultsUserSharesRoute } from './vaults/user/shares';
import { route as vaultsAprRoute } from './vaults/apr';
import { route as vaultsTvlRoute } from './vaults/tvl';
import { route as vaultsSwapVolumeRoute } from './vaults/swap-volume';

import { handleResponse } from '../utils/response';
import { Route } from '../types';

const { NODE_ENV = '' } = process.env;

const developmentRoutes = [...Object.values(debugRoutes)];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const productionRoutes: Route<any, any, any>[] = [
  ...[
    dexLiquidityRoute,
    dexPairsRoute,
    dexPriceRoute,
    dexSwapVolumeRoute,
    dexTradesRoute,
    dexTvlRoute,
  ].flatMap((route) => [
    route,
    // duplicate dex routes to base route
    { ...route, path: route.path.replace(/^\/dex/, '') },
  ]),
  slinkyPriceRoute,
  // allow slinky price route as just "/slinky"
  { ...slinkyPriceRoute, path: slinkyPriceRoute.path.replace('/price', '') },
  vaultsRoute,
  vaultsSharesRoute,
  vaultsUserSharesRoute,
  vaultsUserPnlRoute,
  vaultsPnlRoute,
  vaultsAprRoute,
  vaultsSwapVolumeRoute,
  vaultsTvlRoute,
];

export const routes = [
  // add development only paths if needed
  ...(NODE_ENV === 'development'
    ? [...developmentRoutes, ...productionRoutes]
    : productionRoutes),
];

export const router = Router();

// todo: somehow fix the types between Router and handleResponse correctly
for (const route of routes as Route<object, object>[]) {
  router[route.method](
    route.path,
    handleResponse(
      route.handler,
      route.updateState,
      route.handleAdditionalStreams
    ) as unknown as () => undefined
  );
}
