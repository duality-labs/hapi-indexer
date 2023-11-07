import { RawBuilder, sql } from 'kysely'
import db from '../db';

export function getTokenIdSubQuery(token: string): RawBuilder<{ id: string }> {
  // wrap response in a promise
  return sql`
    SELECT
      'dex.tokens'.'id'
    FROM
      'dex.tokens'
    WHERE (
      'dex.tokens'.'token' = ${token}
    )
  `
}

// get token ID
export default async function getTokenID(token: string) {
  // wrap response in a promise
  return await db
    .get(getTokenIdSubQuery(token).compile())
    .then((result) => {
      // return found id
      return result?.['id'] || undefined;
    });
}
