import * as debugRoutes from './_debug';
import { route as liquidityRoute } from './liquidity';
import { route as queryRoute } from './query';
import { route as swapVolumeRoute } from './swap-volume';

const developmentRoutes = [...Object.values(debugRoutes)];
const productionRoutes = [queryRoute, liquidityRoute, swapVolumeRoute];

export const routes = [
  // add development only paths if needed
  ...(process.env.NODE_ENV === 'development'
    ? [...developmentRoutes, ...productionRoutes]
    : productionRoutes),
];
