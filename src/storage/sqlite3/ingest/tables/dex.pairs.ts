import sql from 'sql-template-tag';

import db, { prepare } from '../../db/db';

import { DecodedTxEvent } from '../utils/decodeEvent';
import getPairID from '../../db/dex.pairs/getPairID';
import { selectTokenID } from '../../db/dex.tokens/selectTokenID';

const pairMap = new Map<string, number>();
export default async function insertDexPairsRows(
  txEvent: DecodedTxEvent
): Promise<number | undefined> {
  // if event has tokens, ensure these tokens are present in the DB
  if (txEvent.attributes.TokenZero && txEvent.attributes.TokenOne) {
    const pairKey = `${txEvent.attributes['TokenZero']}<>${txEvent.attributes['TokenOne']}`;
    const id =
      pairMap.get(pairKey) ??
      (await getPairID(
        txEvent.attributes['TokenZero'],
        txEvent.attributes['TokenOne']
      ));

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
          (${selectTokenID(txEvent.attributes['TokenZero'])}),
          (${selectTokenID(txEvent.attributes['TokenOne'])})
        )
        `)
      )) || {};
    if (!lastID) {
      throw new Error('unable to insert dex.pairs id');
    }
    pairMap.set(pairKey, lastID);
    return lastID;
  }
}
