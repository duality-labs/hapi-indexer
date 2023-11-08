import sql from 'sql-template-tag';
import { selectTokenID } from '../dex.tokens/selectTokenID';

export function selectSortedPairID(token0: string, token1: string) {
  return sql`
    SELECT
      'dex.pairs'.'id'
    FROM
      'dex.pairs'
    WHERE (
      'dex.pairs'.'token0' = (${selectTokenID(token0)}) AND
      'dex.pairs'.'token1' = (${selectTokenID(token1)})
    )
  `;
}

export function selectUnsortedPairID(tokenA: string, tokenB: string) {
  return sql`
    SELECT
      'dex.pairs'.'id'
    FROM
      'dex.pairs'
    WHERE (
      'dex.pairs'.'token0' = (${selectTokenID(tokenA)}) AND
      'dex.pairs'.'token1' = (${selectTokenID(tokenB)})
    ) OR (
      'dex.pairs'.'token1' = (${selectTokenID(tokenA)}) AND
      'dex.pairs'.'token0' = (${selectTokenID(tokenB)})
    )
  `;
}

export const selectPairID = selectUnsortedPairID;
