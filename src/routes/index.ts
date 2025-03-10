import * as debugRoutes from './_debug';
import { route as liquidityRoute } from './liquidity';
import { route as queryRoute } from './query';
import { route as swapVolumeRoute } from './swap-volume';
import { route as tradesRoute } from './trades';

const { NODE_ENV = '', ALLOW_POST_QUERY = '' } = process.env;

const developmentRoutes = [...Object.values(debugRoutes)];
const productionRoutes = [
  // optionally allow general POST/query route (unbounded query complexity)
  ...(['1', 'true'].includes(ALLOW_POST_QUERY) ? [queryRoute] : []),
  liquidityRoute,
  swapVolumeRoute,
  tradesRoute,
];

export const routes = [
  // add development only paths if needed
  ...(NODE_ENV === 'development'
    ? [...developmentRoutes, ...productionRoutes]
    : productionRoutes),
];
