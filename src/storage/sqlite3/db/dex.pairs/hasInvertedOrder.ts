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
          'dex.pairs'.'token0'
        FROM
          'dex.pairs'
        WHERE (
          'dex.pairs'.'token0' = ${tokenA} AND
          'dex.pairs'.'token1' = ${tokenB}
        ) OR (
          'dex.pairs'.'token1' = ${tokenA} AND
          'dex.pairs'.'token0' = ${tokenB}
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
