import sql from 'sql-template-strings';
import { TxResponse } from '../../../../@types/tx';

import db from '../../db/db';

export default async function insertTxRows(tx_result: TxResponse) {
  return await db.run(sql`
    INSERT INTO 'tx' (
      'hash',
      'tx_result.code',
      'tx_result.data',
      'tx_result.info',
      'tx_result.gas_wanted',
      'tx_result.gas_used',
      'tx_result.codespace',

      'related.block'
    ) values (

      ${tx_result.txhash},
      ${tx_result.code},
      ${null},
      ${tx_result.info},
      ${tx_result.gasWanted},
      ${tx_result.gasUsed},
      ${tx_result.codespace},

      (
        SELECT
          'block'.'id'
        FROM
          'block'
        WHERE (
          'block'.'header.height' = ${tx_result.height}
        )
      )
    )
  `);
}
