import sql from 'sql-template-tag';

import db, { prepare } from '../../db/db';

import { DecodedTxEvent } from '../utils/decodeEvent';
import getPairID from '../../db/dex.pairs/getPairID';
import { selectTokenID } from '../../db/dex.tokens/selectTokenID';

export default async function insertDexPairsRows(
  txEvent: DecodedTxEvent
): Promise<number | undefined> {
  // if event has tokens, ensure these tokens are present in the DB
  if (txEvent.attributes.Token0 && txEvent.attributes.Token1) {
    const id = await getPairID(
      txEvent.attributes['Token0'],
      txEvent.attributes['Token1']
    );

    if (id) {
      return id;
    }

    // or insert new token
    const { lastID } =
      (await db.run(
        ...prepare(sql`
        INSERT INTO 'dex.pairs' (
          'token0',
          'token1'
        ) values (
          (${selectTokenID(txEvent.attributes['Token0'])}),
          (${selectTokenID(txEvent.attributes['Token1'])})
        )
        `)
      )) || {};
    if (!lastID) {
      throw new Error('unable to insert dex.pairs id');
    }
    return lastID;
  }
}
