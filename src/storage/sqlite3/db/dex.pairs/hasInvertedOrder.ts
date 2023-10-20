import sql from 'sql-template-tag';
import db, { prepare } from '../db';
import { selectTokenID } from '../dex.tokens/selectTokenID';

// get pair ID without know which is token0 or token1
export default async function hasInvertedOrder(
  tokenA: string,
  tokenB: string
): Promise<boolean | undefined> {
  // wrap response in a promise
  return await db
    .get<{ token0: string }>(
      ...prepare(sql`
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
          'dex.pairs'.'token0' = (${selectTokenID(tokenA)}) AND
          'dex.pairs'.'token1' = (${selectTokenID(tokenB)})
        ) OR (
          'dex.pairs'.'token1' = (${selectTokenID(tokenA)}) AND
          'dex.pairs'.'token0' = (${selectTokenID(tokenB)})
        )
      `)
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
