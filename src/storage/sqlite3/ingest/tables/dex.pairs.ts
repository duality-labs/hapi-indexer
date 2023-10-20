import sql from 'sql-template-strings';

import db from '../../db/db';

import { DecodedTxEvent } from '../utils/decodeEvent';

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
          'dex.pairs'.'token0' = (
            SELECT
              'dex.tokens'.'id'
            FROM
              'dex.tokens'
            WHERE (
              'dex.tokens'.'token' = ${txEvent.attributes.Token0}
            )
          ) AND
          'dex.pairs'.'token1' = (
            SELECT
              'dex.tokens'.'id'
            FROM
              'dex.tokens'
            WHERE (
              'dex.tokens'.'token' = ${txEvent.attributes.Token1}
            )
          )
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
          (
            SELECT
              'dex.tokens'.'id'
            FROM
              'dex.tokens'
            WHERE (
              'dex.tokens'.'token' = ${txEvent.attributes.Token0}
            )
          ),
          (
            SELECT
              'dex.tokens'.'id'
            FROM
              'dex.tokens'
            WHERE (
              'dex.tokens'.'token' = ${txEvent.attributes.Token1}
            )
          )
        )
      `)) || {};
    if (!lastID) {
      throw new Error('unable to insert dex.pairs id');
    }
    return lastID;
  }
}
