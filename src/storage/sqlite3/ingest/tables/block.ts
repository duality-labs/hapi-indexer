import { sql } from 'kysely';
import { TxResponse } from '../../../../@types/tx';

import db from '../../db/db';

export function getBlockTimeFromTxResult(tx_result: TxResponse): number {
  // extract out unix time integer from ISO datetime field of the tx response
  return Math.round(new Date(tx_result.timestamp).valueOf() / 1000);
}

async function get(tx_result: TxResponse) {
  return db.get<{ lastID: number }>(sql`
    SELECT
      'block'.'id' as 'lastID'
    FROM
      'block'
    WHERE (
      'header.height' = ${tx_result.height}
    )
  `);
}

async function set(tx_result: TxResponse) {
  return db.executeQuery(sql`
    INSERT OR IGNORE INTO 'block' (
      'header.height',
      'header.time',
      'header.time_unix'
    ) values (
      ${tx_result.height},
      ${tx_result.timestamp},
      ${getBlockTimeFromTxResult(tx_result)}
    )
  `.compile(db));
}

export default async function insertBlockRows(tx_result: TxResponse) {
  const { lastID } = (await get(tx_result)) || (await set(tx_result));
  if (!lastID) {
    throw new Error('unable to insert dex.pairs id');
  }
  return lastID;
}
