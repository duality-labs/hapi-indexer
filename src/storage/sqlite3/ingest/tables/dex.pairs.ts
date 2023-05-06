import sql from 'sql-template-strings';

import db from '../../db/db';
import { DecodedTxEvent } from './tx_result.events';

export default async function insertDexPairsRows(
  txEvent: DecodedTxEvent
): Promise<number | undefined> {
  // if event has tokens, ensure these tokens are present in the DB
  if (txEvent.attributes.Token0 && txEvent.attributes.Token1) {
    const { id } =
      (await db.get<{ id: number }>(sql`
        SELECT
          'dex.pairs'.'id'
        FROM
          'dex.pairs'
        WHERE (
          'dex.pairs'.'token0' = ${txEvent.attributes.Token0} AND
          'dex.pairs'.'token1' = ${txEvent.attributes.Token1}
        )
      `)) || {};

    if (id) {
      return id;
    }

    // or insert new token
    const { lastID } =
      (await db.run(sql`
        INSERT INTO 'dex.pairs' (
          'token0',
          'token1'
        ) values (
          ${txEvent.attributes.Token0},
          ${txEvent.attributes.Token1}            
        )
      `)) || {};
    if (!lastID) {
      throw new Error('unable to insert dex.pairs id');
    }
    return lastID;
  }
}
