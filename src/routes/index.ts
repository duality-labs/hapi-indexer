import { routes as debugRoutes } from './_debug';
import { route as queryRoute } from './query';
import { route as swapVolumeRoute } from './swap-volume';

const developmentRoutes = debugRoutes;
const productionRoutes = [queryRoute, swapVolumeRoute];

export const routes = [
  // add development only paths if needed
  ...(process.env.NODE_ENV === 'development'
    ? [...developmentRoutes, ...productionRoutes]
    : productionRoutes),
];
