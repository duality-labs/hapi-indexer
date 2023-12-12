import sql from 'sql-template-tag';
import BigNumber from 'bignumber.js';
import { Policy, PolicyOptions } from '@hapi/catbox';

import db, { prepare } from '../db';
import selectLatestTickState, {
  selectTickIndexesOfTickState,
} from './selectLatestDerivedTickState';

import { getLastBlockHeight } from '../../../../sync';
import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';
import { DataRowA } from './getTokenPairLiquidity';

export type DataRow = DataRowA;
export type TickLiquidity = DataRow[];
export type LiquidityCache = Policy<
  TickLiquidity,
  PolicyOptions<TickLiquidity>
>;

interface TickStateTableRow {
  tickIndex: number;
  reserves: string;
}

export const tickLiquidityCache: PolicyOptions<TickLiquidity> = {
  expiresIn: 1000 * 60, // allow for a few block heights
  generateFunc: async (id) => {
    const [token0, token1, tokenIn] = `${id}`.split('|');
    const [fromHeight, toHeight] = `${id}`.split('|').slice(3).map(Number);
    if (!token0 || !token1) {
      throw new Error('Tokens not specified', { cause: 400 });
    }
    // it is important that the cache is called with height restrictions:
    // this ensures that the result is deterministic and can be cached
    // indefinitely (an unbound height result may change with time)
    if (fromHeight === undefined || toHeight === undefined) {
      throw new Error('Height restrictions are required', { cause: 400 });
    }
    const lastBlockHeight = getLastBlockHeight();
    if (fromHeight > lastBlockHeight || toHeight > lastBlockHeight) {
      throw new Error('Height is not bound to known data', { cause: 400 });
    }
    if (toHeight <= fromHeight) {
      throw new Error('Height query will produce no data', { cause: 400 });
    }

    // return the result set
    return await db
      .all<TickStateTableRow[]>(
        ...prepare(sql`
          WITH 'latest.derived.tick_state' AS (${selectLatestTickState(
            token0,
            token1,
            tokenIn,
            { fromHeight: 0, toHeight }
          )})
            SELECT
              'latest.derived.tick_state'.'TickIndex' as 'tickIndex',
              -- sum reserves for all found unique Fee rows of each TickIndex
              SUM( CAST('latest.derived.tick_state'.'Reserves' AS FLOAT) ) as 'reserves'
            FROM
              'latest.derived.tick_state'
            ${
              // add where clause dependent on full state or update request
              fromHeight === 0
                ? // filter zero values if querying from the start of chain
                  // as zero values won't be helpful to receive or use
                  sql`
                    WHERE 'latest.derived.tick_state'.'Reserves' != '0'
                  `
                : // when querying an update we find the tick indexes that have
                  // change at this update height, and filter to those
                  sql`
                    WHERE 'latest.derived.tick_state'.'TickIndex' in (${selectTickIndexesOfTickState(
                      token0,
                      token1,
                      tokenIn,
                      { fromHeight, toHeight }
                    )})
                  `
            }
            -- sum reserves across tick indexes
            GROUP BY 'latest.derived.tick_state'.'TickIndex'
            -- order by most important (middle) ticks first
            ORDER BY 'latest.derived.tick_state'.'TickIndex' ASC
        `)
      )
      // transform data for the tickIndexes to be in terms of A/B.
      .then((data) => {
        return data.map((row): DataRow => {
          return [
            // invert the indexes to transform tick index from AtoB to BtoA (A/B)
            -row['tickIndex'],
            // return reserves as a number (of smaller precision to save bytes)
            Number(new BigNumber(row['reserves']).toPrecision(3)),
          ];
        });
      });
  },
  generateTimeout: 1000 * 20,
};

export async function getTickLiquidity(
  liquidityCache: LiquidityCache,
  token0: string,
  token1: string,
  tokenIn: string,
  {
    fromHeight = 0,
    toHeight = getLastBlockHeight(),
  }: { fromHeight?: string | number; toHeight?: string | number } = {}
): Promise<TickLiquidity | null> {
  // get liquidity state through cache
  const cacheKey = [token0, token1, tokenIn, fromHeight, toHeight].join('|');
  return await liquidityCache.get(cacheKey);
}

export async function getUnsortedTickLiquidity(
  liquidityCache: LiquidityCache,
  tokenA: string,
  tokenB: string,
  tokenIn: string,
  heights: { fromHeight?: string | number; toHeight?: string | number } = {}
): Promise<TickLiquidity | null> {
  const invertedOrder = await hasInvertedOrder(tokenA, tokenB);
  const token0 = invertedOrder ? tokenB : tokenA;
  const token1 = invertedOrder ? tokenA : tokenB;
  return getTickLiquidity(liquidityCache, token0, token1, tokenIn, heights);
}
