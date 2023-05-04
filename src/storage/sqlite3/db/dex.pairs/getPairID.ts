import sql from 'sql-template-strings';
import db from '../db';

// get pair ID without know which is token0 or token1
export default async function getPairID(tokenA: string, tokenB: string) {
  // wrap response in a promise
  return await db
    .get(
      sql`
        SELECT 'dex.pairs'.'id' FROM 'dex.pairs' WHERE (
          'dex.pairs'.'token0' = ${tokenA} AND
          'dex.pairs'.'token1' = ${tokenB}
        ) OR (
          'dex.pairs'.'token1' = ${tokenA} AND
          'dex.pairs'.'token0' = ${tokenB}
        )
      `
    )
    .then((result) => {
      // return found id
      return result?.['id'] || undefined;
    });
}
