import BigNumber from 'bignumber.js';
import { Policy, PolicyOptions } from '@hapi/catbox';

import db from '../db';
import getLatestTickStateCTE from './getLatestDerivedTickState';

import { getLastBlockHeight } from '../../../../sync';
import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';

export type DataRow = [tick_index: number, reserves: number];
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
    const reverseDirection = token1 === tokenIn;
    return await db
      .all<TickStateTableRow[]>(
        // append plain SQL (without sql substitution) for conditional sections
        getLatestTickStateCTE(token0, token1, tokenIn, { fromHeight, toHeight })
          .append(`--sql
            SELECT
              'latest.derived.tick_state'.'TickIndex' as 'tickIndex',
              'latest.derived.tick_state'.'Reserves' as 'reserves'
            FROM
              'latest.derived.tick_state'
            ${
              // add a filtering of zero values if querying from the beginning
              // as zero values won't be helpful to receive or use
              fromHeight === 0
                ? `--sql
                    WHERE 'latest.derived.tick_state'.'Reserves' != '0'
                  `
                : ''
            }
            -- order by tick side
            -- order by most important (middle) ticks first
            ORDER BY 'latest.derived.tick_state'.'TickIndex' ${
              reverseDirection ? 'ASC' : 'DESC'
            }
          `)
      )
      // transform data for the tickIndexes to be in terms of A/B.
      .then((data) => {
        return data.map((row): DataRow => {
          return [
            // invert the indexes depending on which price ratio was asked for
            // so the indexes are in terms of token/otherToken
            reverseDirection ? -row['tickIndex'] : row['tickIndex'],
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
