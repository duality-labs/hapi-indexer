import sql from 'sql-template-tag';
import { Policy, PolicyOptions } from '@hapi/catbox';

import db, { prepare } from '../db';
import { getLastBlockHeight } from '../../../../sync';
import { RequestQuery } from '@hapi/hapi';
import { getBlockRange } from '../blockRangeUtils';

export type DataRow = [
  token0: string,
  token1: string,
  reserves0: number,
  reserves1: number
];
export type TokenPairsLiquidity = DataRow[];
export type LiquidityCache = Policy<
  TokenPairsLiquidity,
  PolicyOptions<TokenPairsLiquidity>
>;

interface TokensVolumeTableRow {
  token0: string;
  token1: string;
  reserves0: number;
  reserves1: number;
}

export const tokenPairsLiquidityCache: PolicyOptions<TokenPairsLiquidity> = {
  expiresIn: 1000 * 60, // allow for a few block heights
  generateFunc: async (id) => {
    const [fromHeight, toHeight] = `${id}`.split('|').map(Number);
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
      .all<TokensVolumeTableRow[]>(
        ...prepare(sql`
          SELECT
            'dex.tokens_0'.'token' as 'token0',
            'dex.tokens_1'.'token' as 'token1',
            'derived.tx_volume_data'.'ReservesFloat0' as 'reserves0',
            'derived.tx_volume_data'.'ReservesFloat1' as 'reserves1'
          FROM
            'dex.pairs'
          INNER JOIN
            'dex.tokens' as 'dex.tokens_0'
          ON (
            'dex.tokens_0'.'id' = 'dex.pairs'.'token0'
          )
          INNER JOIN
            'dex.tokens' as 'dex.tokens_1'
          ON (
            'dex.tokens_1'.'id' = 'dex.pairs'.'token1'
          )
          INNER JOIN
            'derived.tx_volume_data'
          ON (
            'derived.tx_volume_data'.'related.dex.pair' = 'dex.pairs'.'id'
          )
          WHERE (
            'derived.tx_volume_data'.'related.block.header.height' > ${fromHeight} AND
            'derived.tx_volume_data'.'related.block.header.height' <= ${toHeight}
          )
          GROUP BY 'derived.tx_volume_data'.'related.dex.pair'
          HAVING max('derived.tx_volume_data'.'related.tx_result.events')
        `)
      )
      // transform data for the tickIndexes to be in terms of A/B.
      .then((data: TokensVolumeTableRow[]) => {
        return data.map<DataRow>((row) => {
          return [row.token0, row.token1, row.reserves0, row.reserves1];
        });
      });
  },
  generateTimeout: 1000 * 20,
};

export type HeightedTokenPairsLiquidity = [
  height: number,
  tokenPairsLiquidity: TokenPairsLiquidity
];

export async function getHeightedTokenPairsLiquidity(
  liquidityCache: LiquidityCache,
  query: RequestQuery
): Promise<HeightedTokenPairsLiquidity | null> {
  const {
    from_height: fromHeight = 0,
    to_height: toHeight = getLastBlockHeight(),
  } = getBlockRange(query);

  // get liquidity state through cache
  const cacheID = [fromHeight, toHeight].join('|');
  const tokenPairsLiquidity = await liquidityCache.get(cacheID);
  // return the response data
  if (tokenPairsLiquidity !== null) {
    return [toHeight, tokenPairsLiquidity];
  } else {
    return null;
  }
}
