import sql from 'sql-template-tag';

import db, { prepare } from '../../db/db';

import { DecodedTxEvent } from '../utils/decodeEvent';
import { selectTokenID } from '../../db/dex.tokens/selectTokenID';

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
          (await db.get<{ id: number }>(...prepare(selectTokenID(token)))) ||
          {};
        if (id) {
          return id;
        }
        // or insert new token
        const { lastID } =
          (await db.run(
            ...prepare(sql`
            INSERT INTO 'dex.tokens' ('token') values (${token})
            `)
          )) || {};
        if (!lastID) {
          throw new Error('unable to insert dex.tokens id');
        }
        return lastID;
      })
    );
  }
}
