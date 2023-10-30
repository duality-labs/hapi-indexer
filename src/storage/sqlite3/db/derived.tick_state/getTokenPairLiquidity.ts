import BigNumber from 'bignumber.js';
import sql from 'sql-template-strings';
import { Request } from '@hapi/hapi';
import { Policy, PolicyOptions } from '@hapi/catbox';

import db from '../db';
import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';
import { getLastBlockHeight } from '../../../../sync';

export type DataRow = [tick_index: number, reserves: number];

interface TickStateTableRow {
  tickIndex: number;
  reserves: string;
}

async function getTickState(
  token0: string,
  token1: string,
  token: string,
  fromHeight: number,
  toHeight: number
) {
  const reverseDirection = token1 === token;
  return await db
    .all<TickStateTableRow[]>(
      sql`
      WITH 'latest.derived.tick_state' AS (
        SELECT
          'derived.tick_state'.'TickIndex' as 'TickIndex',
          'derived.tick_state'.'Reserves' as 'Reserves'
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
          'derived.tick_state'.'related.block.header.height' <= ${toHeight}
        )
        GROUP BY 'derived.tick_state'.'TickIndex'
        HAVING max('derived.tick_state'.'related.block.header.height')
      )
    `.append(`--sql
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
}

type HeightedTokenPairLiquidity = [
  height: number,
  reservesTokenA: DataRow[],
  reservesTokenB: DataRow[]
];

type LiquidityCache = Policy<
  HeightedTokenPairLiquidity,
  PolicyOptions<HeightedTokenPairLiquidity>
>;

let liquidityCache: LiquidityCache;
function getLiquidityCache(server: Request['server']) {
  if (!liquidityCache) {
    liquidityCache = server.cache<HeightedTokenPairLiquidity>({
      segment: '/liquidity/token/tokenA/tokenB',
      expiresIn: 1000 * 60, // allow for a few block heights
      generateFunc: async (id) => {
        const [token0, token1] = `${id}`.split('|');
        const [fromHeight, toHeight] = `${id}`.split('|').slice(2).map(Number);
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
        const heightedPairState = await new Promise<HeightedTokenPairLiquidity>(
          (resolve, reject) => {
            db.getDatabaseInstance().parallelize(() => {
              Promise.all([
                // get result height
                toHeight,
                // get tokenA liquidity
                getTickState(token0, token1, token0, fromHeight, toHeight),
                // get tokenB liquidity
                getTickState(token0, token1, token1, fromHeight, toHeight),
              ])
                .then((promises) => resolve(promises))
                .catch((error) => reject(error));
            });
          }
        );
        // return this cache set
        return heightedPairState;
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
    toHeight = getLastBlockHeight(),
  }: { fromHeight?: string | number; toHeight?: string | number } = {}
): Promise<HeightedTokenPairLiquidity | null> {
  const liquidityCache = getLiquidityCache(server);
  const invertedOrder = await hasInvertedOrder(tokenA, tokenB);
  const token0 = invertedOrder ? tokenB : tokenA;
  const token1 = invertedOrder ? tokenA : tokenB;

  // get liquidity state through cache
  const cacheKey = [token0, token1, fromHeight, toHeight].join('|');
  const response = await liquidityCache.get(cacheKey);
  // return the response data in the correct order
  if (response) {
    const [height, tickState0, tickState1] = response;
    return invertedOrder
      ? [height, tickState1, tickState0]
      : [height, tickState0, tickState1];
  } else {
    return null;
  }
}
