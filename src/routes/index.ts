import Router from 'router';
import * as debugRoutes from './_debug';
import { route as liquidityRoute } from './liquidity';
import { route as priceRoute } from './price';
import { route as slinkyRoute } from './slinky';
import { route as swapVolumeRoute } from './swap-volume';
import { route as tradesRoute } from './trades';
import { route as tvlRoute } from './tvl';
import { route as vaultAprRoute } from './vaults/apr';
import { route as vaultsTvlRoute } from './vaults/tvl';
import { route as vaultsSwapVolumeRoute } from './vaults/swap-volume';

import { GetData, handleResponse } from '../utils/response';

const { NODE_ENV = '' } = process.env;

const developmentRoutes = [...Object.values(debugRoutes)];
const productionRoutes = [
  liquidityRoute,
  priceRoute,
  slinkyRoute,
  swapVolumeRoute,
  tradesRoute,
  tvlRoute,
  vaultAprRoute,
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

for (const route of routes) {
  router[route.method](
    route.path,
    // todo: somehow fix the types between Router and handleResponse correctly
    handleResponse(
      route.handler as GetData<object, object>
    ) as unknown as () => undefined
  );
}
