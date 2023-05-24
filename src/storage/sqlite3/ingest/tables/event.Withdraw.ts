import sql from 'sql-template-strings';
import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';

import db from '../../db/db';
import { getBlockTimeFromTxResult } from './block';

import { BaseDexEventAttributeMap, DecodedTxEvent } from '../utils/eventTypes';

export interface WithdrawEventAttributeMap extends BaseDexEventAttributeMap<'Withdraw'> {
  Creator: string;
  Receiver: string;
  Token0: string;
  Token1: string;
  TickIndex: string;
  Fee: string;
  Reserves0Withdrawn: string;
  Reserves1Withdrawn: string;
  SharesRemoved: string;
}

export default async function insertEventWithdraw(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent<WithdrawEventAttributeMap>,
  index: number
) {
  return await db.run(sql`
    INSERT INTO 'event.Withdraw' (
      'block.header.height',
      'block.header.time_unix',
      'tx.index',
      'tx_result.events.index',

      'Creator',
      'Receiver',
      'Token0',
      'Token1',
      'TickIndex',
      'Fee',
      'Reserves0Withdrawn',
      'Reserves1Withdrawn',
      'SharesRemoved',

      'meta.dex.pair'
    ) values (
      ${tx_result.height},
      ${getBlockTimeFromTxResult(tx_result)},
      ${index},
      ${txEvent.index},
      ${txEvent.attributes['Creator']},
      ${txEvent.attributes['Receiver']},
      ${txEvent.attributes['Token0']},
      ${txEvent.attributes['Token1']},
      ${txEvent.attributes['TickIndex']},
      ${txEvent.attributes['Fee']},
      ${txEvent.attributes['Reserves0Withdrawn']},
      ${txEvent.attributes['Reserves1Withdrawn']},
      ${txEvent.attributes['SharesRemoved']},

      (
        SELECT
          'dex.pairs'.'id'
        FROM
          'dex.pairs'
        WHERE (
          'dex.pairs'.'Token0' = ${txEvent.attributes['Token0']} AND
          'dex.pairs'.'Token1' = ${txEvent.attributes['Token1']}
        )
      )
    )
  `);
}
