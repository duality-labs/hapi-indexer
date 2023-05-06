import sql from 'sql-template-strings';

import db from '../../db/db';
import { DecodedTxEvent } from './tx_result.events';

export default async function insertDexTokensRows(
  txEvent: DecodedTxEvent
): Promise<void> {
  // if event has tokens, ensure these tokens are present in the DB
  const tokens = [
    txEvent.attributes.Token0,
    txEvent.attributes.Token1,
    txEvent.attributes.TokenIn,
    txEvent.attributes.TokenOut,
    txEvent.attributes.Token,
  ]
    .filter(Boolean) // remove falsy
    .reduce<string[]>(
      (acc, token) => (acc.includes(token) ? acc : acc.concat(token)),
      []
    ); // remove duplicates
  // loop through all found
  if (tokens.length > 0) {
    await Promise.all(
      tokens.map(async (token) => {
        const { id } =
          (await db.get<{ id: number }>(sql`
            SELECT
              'dex.tokens'.'id'
            FROM
              'dex.tokens'
            WHERE (
              'dex.tokens'.'token' = ${token}
            )
          `)) || {};
        if (id) {
          return id;
        }
        // or insert new token
        const { lastID } =
          (await db.run(sql`
            INSERT INTO 'dex.tokens' ('token') values (${token})
          `)) || {};
        if (!lastID) {
          throw new Error('unable to insert dex.tokens id');
        }
        return lastID;
      })
    );
  }
}
