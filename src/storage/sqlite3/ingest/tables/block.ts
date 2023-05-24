import sql from 'sql-template-strings';
import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';

import db from '../../db/db';

export function getBlockTimeFromTxResult(tx_result: TxResponse): number {
  // extract out unix time integer from ISO datetime field of the tx response
  return Math.round(new Date(tx_result.timestamp).valueOf() / 1000);
}

export default async function insertBlockRows(tx_result: TxResponse) {
  // activate at run time (after db has been initialized)
  return await db.run(sql`
    INSERT OR IGNORE INTO 'block' (
      'header.height',
      'header.time',
      'header.time_unix'
    ) values (
      ${tx_result.height},
      ${tx_result.timestamp},
      ${getBlockTimeFromTxResult(tx_result)}
    )
  `);
}
