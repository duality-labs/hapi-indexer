import sql from 'sql-template-tag';

import db, { prepare } from '../../db/db';

import { DecodedTxEvent } from '../utils/decodeEvent';
import { selectSortedPairID } from '../../db/dex.pairs/selectPairID';

export default async function insertDexPairsRows(
  txEvent: DecodedTxEvent
): Promise<number | undefined> {
  // if event has tokens, ensure these tokens are present in the DB
  if (txEvent.attributes.Token0 && txEvent.attributes.Token1) {
    const { id } =
      (await db.get<{ id: number }>(
        ...prepare(
          selectSortedPairID(
            txEvent.attributes['Token0'],
            txEvent.attributes['Token1']
          )
        )
      )) || {};

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
          ${txEvent.attributes.Token0},
          ${txEvent.attributes.Token1}            
        )
        `)
      )) || {};
    if (!lastID) {
      throw new Error('unable to insert dex.pairs id');
    }
    return lastID;
  }
}
