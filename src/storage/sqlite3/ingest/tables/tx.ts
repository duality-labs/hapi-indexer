import sql from 'sql-template-tag';
import { TxResponse } from '../../../../@types/tx';

import db, { prepare } from '../../db/db';

export default async function insertTxRows(
  tx_result: TxResponse,
  index: number
) {
  return await db.run(
    ...prepare(sql`
    INSERT INTO 'tx' (
      'hash',
      'index',
      'tx_result.code',
      'tx_result.data',
      'tx_result.info',
      'tx_result.gas_wanted',
      'tx_result.gas_used',
      'tx_result.codespace',

      'related.block'
    ) values (

      ${tx_result.txhash},
      ${index},
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
    `)
  );
}
