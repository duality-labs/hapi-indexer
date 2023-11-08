import sql from 'sql-template-tag';

export function selectSortedPairID(token0: string, token1: string) {
  return sql`
    SELECT
      'dex.pairs'.'id'
    FROM
      'dex.pairs'
    WHERE (
      'dex.pairs'.'token0' = ${token0} AND
      'dex.pairs'.'token1' = ${token1}
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
      'dex.pairs'.'token0' = ${tokenA} AND
      'dex.pairs'.'token1' = ${tokenB}
    ) OR (
      'dex.pairs'.'token1' = ${tokenA} AND
      'dex.pairs'.'token0' = ${tokenB}
    )
  `;
}

export const selectPairID = selectUnsortedPairID;
