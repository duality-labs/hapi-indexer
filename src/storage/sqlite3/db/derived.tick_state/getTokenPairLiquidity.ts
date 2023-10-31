import { Request } from '@hapi/hapi';

import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';
import { getLastBlockHeight } from '../../../../sync';
import {
  LiquidityCache,
  TickLiquidity,
  getTickLiquidity,
  tickLiquidityCache,
} from './getTickLiquidity';

export type DataRow = [tick_index: number, reserves: number];

type HeightedTokenPairLiquidity = [
  height: number,
  reservesTokenA: DataRow[],
  reservesTokenB: DataRow[]
];

let liquidityCache: LiquidityCache;
function getLiquidityCache(server: Request['server']) {
  if (!liquidityCache) {
    liquidityCache = server.cache<TickLiquidity>({
      segment: '/liquidity/token/tokenA/tokenB',
      ...tickLiquidityCache,
    });
  }
  return liquidityCache;
}

export async function getHeightedTokenPairLiquidity(
  server: Request['server'],
  tokenA: string,
  tokenB: string,
  {
    fromHeight = 0,
    toHeight = getLastBlockHeight(),
  }: { fromHeight?: string | number; toHeight?: string | number } = {}
): Promise<HeightedTokenPairLiquidity | null> {
  const liquidityCache = getLiquidityCache(server);
  const invertedOrder = await hasInvertedOrder(tokenA, tokenB);
  const token0 = invertedOrder ? tokenB : tokenA;
  const token1 = invertedOrder ? tokenA : tokenB;
  const heights = { fromHeight, toHeight };

  // get liquidity state through cache
  const [tickStateA, tickStateB] = await Promise.all([
    getTickLiquidity(liquidityCache, token0, token1, tokenA, heights),
    getTickLiquidity(liquidityCache, token0, token1, tokenB, heights),
  ]);
  // return the response data in the correct order
  const height = Number(toHeight);
  if (height > 0 && tickStateA !== null && tickStateB !== null) {
    return [height, tickStateB, tickStateA];
  } else {
    return null;
  }
}
