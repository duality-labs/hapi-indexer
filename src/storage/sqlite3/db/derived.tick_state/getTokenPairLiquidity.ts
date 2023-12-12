import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';
import { LiquidityCache, getTickLiquidity } from './getTickLiquidity';

import { getLastBlockHeight } from '../../../../sync';
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
  const {
    from_height: fromHeight = 0,
    to_height: toHeight = getLastBlockHeight(),
  } = getBlockRange(query);
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
    return [height, tickStateA, tickStateB];
  } else {
    return null;
  }
}
