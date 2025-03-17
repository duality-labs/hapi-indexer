import Router from 'router';
import * as debugRoutes from './_debug';
import { route as liquidityRoute } from './liquidity';
import { route as priceRoute } from './price';
import { route as swapVolumeRoute } from './swap-volume';
import { route as tradesRoute } from './trades';

const { NODE_ENV = '' } = process.env;

const developmentRoutes = [...Object.values(debugRoutes)];
const productionRoutes = [
  liquidityRoute,
  priceRoute,
  swapVolumeRoute,
  tradesRoute,
];

export const routes = [
  // add development only paths if needed
  ...(NODE_ENV === 'development'
    ? [...developmentRoutes, ...productionRoutes]
    : productionRoutes),
] as unknown as Array<{
  method: 'get' | 'post';
  path: string;
  handler: () => undefined;
}>;

export const router = Router();

for (const route of routes) {
  router[route.method.toLowerCase() as 'get' | 'post'](
    route.path,
    route.handler
  );
}
