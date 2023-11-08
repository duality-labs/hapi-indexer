import sql from 'sql-template-tag';
import { TxResponse } from '../../../../@types/tx';

import db, { prepare } from '../../db/db';

import { DecodedTxEvent } from '../utils/decodeEvent';

export default async function insertEventDeposit(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number
) {
  return await db.run(
    ...prepare(sql`
    INSERT INTO 'event.Deposit' (

      'Creator',
      'Receiver',
      'Token0',
      'Token1',
      'TickIndex',
      'Fee',
      'Reserves0Deposited',
      'Reserves1Deposited',
      'SharesMinted',

      'related.tx_result.events',
      'related.dex.pair'
    ) values (
      ${txEvent.attributes['Creator']},
      ${txEvent.attributes['Receiver']},
      ${txEvent.attributes['Token0']},
      ${txEvent.attributes['Token1']},
      ${txEvent.attributes['TickIndex']},
      ${txEvent.attributes['Fee']},
      ${txEvent.attributes['Reserves0Deposited']},
      ${txEvent.attributes['Reserves1Deposited']},
      ${txEvent.attributes['SharesMinted']},

      (
        SELECT
          'tx_result.events'.'id'
        FROM
          'tx_result.events'
        WHERE (
          'tx_result.events'.'index' = ${txEvent.index} AND
          'tx_result.events'.'related.tx' = (
            SELECT
              'tx'.'id'
            FROM
              'tx'
            WHERE (
              'tx'.'index' = ${index} AND
              'tx'.'related.block' = (
                SELECT
                  'block'.'id'
                FROM
                  'block'
                WHERE (
                  'block'.'header.height' = ${tx_result.height}
                )
              )
            )
          )
        )
      ),
      (
        SELECT
          'dex.pairs'.'id'
        FROM
          'dex.pairs'
        WHERE (
          'dex.pairs'.'token0' = ${txEvent.attributes['Token0']} AND
          'dex.pairs'.'token1' = ${txEvent.attributes['Token1']}
        )
      )
    )
    `)
  );
}
