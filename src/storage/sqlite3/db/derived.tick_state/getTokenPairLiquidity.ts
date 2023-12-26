import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';
import { LiquidityCache, getTickLiquidity } from './getTickLiquidity';

import { RequestQuery } from '@hapi/hapi';
import { getBlockRange } from '../blockRangeUtils';

export type DataRowA = [tick_index_b_to_a: number, reserves: number];
export type DataRowB = [tick_index_b_to_a: number, reserves: number];

export type HeightedTokenPairLiquidity = [
  height: number,
  reservesTokenA: DataRowA[],
  reservesTokenB: DataRowB[]
];

export async function getHeightedTokenPairLiquidity(
  liquidityCache: LiquidityCache,
  tokenA: string,
  tokenB: string,
  query: RequestQuery
): Promise<HeightedTokenPairLiquidity | null> {
  const blockRange = await getBlockRange(query);

  const invertedOrder = await hasInvertedOrder(tokenA, tokenB);
  const token0 = invertedOrder ? tokenB : tokenA;
  const token1 = invertedOrder ? tokenA : tokenB;
  const heights = {
    fromHeight: blockRange.from_height,
    toHeight: blockRange.to_height,
  };

  // get liquidity state through cache
  const [tickStateA, tickStateB] = await Promise.all([
    getTickLiquidity(liquidityCache, token0, token1, tokenA, heights),
    getTickLiquidity(liquidityCache, token0, token1, tokenB, heights),
  ]);
  // return the response data in the correct order
  const height = Number(blockRange.to_height);
  if (height > 0 && tickStateA !== null && tickStateB !== null) {
    return [height, tickStateA, tickStateB];
  } else {
    return null;
  }
}
