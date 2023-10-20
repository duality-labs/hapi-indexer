import sql from 'sql-template-strings';
import db from '../db';

// get pair ID without know which is token0 or token1
export default async function hasInvertedOrder(
  tokenA: string,
  tokenB: string
): Promise<boolean | undefined> {
  // wrap response in a promise
  return await db
    .get<{ token0: string }>(
      sql`
        SELECT
          'dex.tokens'.'token' as 'token0'
        FROM
          'dex.tokens'
        JOIN
          'dex.pairs'
        ON (
          'dex.pairs'.'token0' == 'dex.tokens'.'id'
        )
        WHERE (
          'dex.pairs'.'token0' = (
            SELECT
              'dex.tokens'.'id'
            FROM
              'dex.tokens'
            WHERE (
              'dex.tokens'.'token' = ${tokenA}
            )
          ) AND
          'dex.pairs'.'token1' = (
            SELECT
              'dex.tokens'.'id'
            FROM
              'dex.tokens'
            WHERE (
              'dex.tokens'.'token' = ${tokenB}
            )
          )
        ) OR (
          'dex.pairs'.'token1' = (
            SELECT
              'dex.tokens'.'id'
            FROM
              'dex.tokens'
            WHERE (
              'dex.tokens'.'token' = ${tokenA}
            )
          ) AND
          'dex.pairs'.'token0' = (
            SELECT
              'dex.tokens'.'id'
            FROM
              'dex.tokens'
            WHERE (
              'dex.tokens'.'token' = ${tokenB}
            )
          )
        )
      `
    )
    .then((result) => {
      // does tokenA/B match token 0/1?
      const token0 = result?.['token0'];
      switch (token0) {
        case tokenA:
          return false;
        case tokenB:
          return true;
        default:
          return undefined;
      }
    });
}
