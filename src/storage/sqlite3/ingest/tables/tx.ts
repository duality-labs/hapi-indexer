import sql from 'sql-template-strings';
import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';

import db from '../../db/db';
import { getBlockTimeFromTxResult } from './block';

export default async function insertTxRows(
  tx_result: TxResponse,
  index: number
) {
  return await db.run(sql`
    INSERT INTO 'tx' (
      'block.header.height',
      'block.header.time_unix',
      'hash',
      'index',
      'tx_result.code',
      'tx_result.data',
      'tx_result.log',
      'tx_result.info',
      'tx_result.gas_wanted',
      'tx_result.gas_used',
      'tx_result.codespace'
    ) values (
      ${tx_result.height},
      ${getBlockTimeFromTxResult(tx_result)},
      ${tx_result.txhash},
      ${index},
      ${tx_result.code},
      ${tx_result.data},
      ${tx_result.rawLog},
      ${tx_result.info},
      ${tx_result.gasWanted},
      ${tx_result.gasUsed},
      ${tx_result.codespace}
    )
  `);
}
