import sql from 'sql-template-strings';
import db from '../db';

// get token ID
export default async function getTokenID(token: string) {
  // wrap response in a promise
  return await db
    .get(
      sql`
        SELECT
          'dex.tokens'.'id'
        FROM
          'dex.tokens'
        WHERE (
          'dex.tokens'.'token' = ${token}
        )
      `
    )
    .then((result) => {
      // return found id
      return result?.['id'] || undefined;
    });
}
