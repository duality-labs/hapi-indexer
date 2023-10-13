import BigNumber from 'bignumber.js';
import sql from 'sql-template-strings';
import { CachePolicyOptions, Request } from '@hapi/hapi';
import { Policy } from '@hapi/catbox';

import db from '../db';
import getHeight from '../block/getHeight';
import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';

export type DataRow = [tick_index: number, reserves: number];

interface TickStateTableRow {
  tickIndex: number;
  reserves: string;
}

async function getTickState(
  token0: string,
  token1: string,
  token: string,
  fromHeight = 0
) {
  const reverseDirection = token1 === token;
  return await db
    .all<TickStateTableRow[]>(
      sql`
      SELECT
        'derived.tick_state'.'TickIndex' as 'tickIndex',
        'derived.tick_state'.'Reserves' as 'reserves'
      FROM
        'derived.tick_state'
      WHERE (
        'derived.tick_state'.'related.dex.pair' = (
          SELECT
            'dex.pairs'.'id'
          FROM
            'dex.pairs'
          WHERE (
            'dex.pairs'.'token0' = ${token0} AND
            'dex.pairs'.'token1' = ${token1}
          )
        ) AND
        'derived.tick_state'.'related.dex.token' = (
          SELECT
            'dex.tokens'.'id'
          FROM
            'dex.tokens'
          WHERE (
            'dex.tokens'.'Token' = ${token}
          )
        ) AND
        'derived.tick_state'.'related.block.header.height' > ${fromHeight} AND
        -- when returning an update: zero value reserves are important to know
        'derived.tick_state'.'Reserves' != ${fromHeight > 0 ? '' : '0'}
      )
    `.append(`--sql
      -- order by tick side
      -- order by most important (middle) ticks first
      ORDER BY 'derived.tick_state'.'TickIndex' ${
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
}

export type HeightedTickState = [number, DataRow[], DataRow[]];

type LiquidityCache = Policy<
  HeightedTickState,
  CachePolicyOptions<HeightedTickState>
>;
let liquidityCache: LiquidityCache;
function getLiquidityCache(server: Request['server']) {
  if (!liquidityCache) {
    liquidityCache = server.cache<HeightedTickState>({
      segment: '/liquidity/token/tokenA/tokenB',
      expiresIn: 1000 * 60, // allow for a few block heights
      generateFunc: async (id) => {
        const [token0, token1, fromHeight = 0] = `${id}`.split('|');
        if (!token0 || !token1) {
          throw new Error('Tokens not specified');
        }
        const ticksState = await new Promise<HeightedTickState>(
          (resolve, reject) => {
            db.getDatabaseInstance().parallelize(() => {
              Promise.all([
                // get chain height
                getHeight(),
                // get tokenA liquidity
                getTickState(token0, token1, token0, Number(fromHeight)),
                // get tokenB liquidity
                getTickState(token0, token1, token1, Number(fromHeight)),
              ])
                .then((promises) => resolve(promises))
                .catch((error) => reject(error));
            });
          }
        );
        const [height] = ticksState;
        // set cache entry with this height for future lookups
        liquidityCache.set(
          [token0, token1, fromHeight, height].join('|'),
          ticksState
        );
        // return this cache set
        return ticksState;
      },
      generateTimeout: 1000 * 20,
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
    toHeight,
  }: { fromHeight?: string | number; toHeight?: string | number } = {}
): Promise<HeightedTickState | null> {
  const liquidityCache = getLiquidityCache(server);
  const invertedOrder = await hasInvertedOrder(tokenA, tokenB);
  const token0 = invertedOrder ? tokenB : tokenA;
  const token1 = invertedOrder ? tokenA : tokenB;

  // get liquidity state through cache
  const response = await liquidityCache.get(
    [token0, token1, fromHeight, toHeight].join('|')
  );
  // return the response data in the correct order
  if (response) {
    const [height, tickState0, tickState1] = Array.isArray(response)
      ? response
      : response.value;
    return invertedOrder
      ? [height, tickState1, tickState0]
      : [height, tickState0, tickState1];
  } else {
    return null;
  }
}
