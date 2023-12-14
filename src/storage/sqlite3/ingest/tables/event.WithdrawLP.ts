import sql from 'sql-template-tag';
import { TxResponse } from '../../../../@types/tx';

import db, { prepare } from '../../db/db';

import { DecodedTxEvent } from '../utils/decodeEvent';
import { selectSortedPairID } from '../../db/dex.pairs/selectPairID';

export default async function insertEventWithdraw(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number
) {
  return await db.run(
    ...prepare(sql`
    INSERT INTO 'event.WithdrawLP' (

      'Creator',
      'Receiver',
      'TokenZero',
      'TokenOne',
      'TickIndex',
      'Fee',
      'ReservesZeroWithdrawn',
      'ReservesOneWithdrawn',
      'SharesRemoved',

      'related.tx_result.events',
      'related.dex.pair'
    ) values (

      ${txEvent.attributes['Creator']},
      ${txEvent.attributes['Receiver']},
      ${txEvent.attributes['TokenZero']},
      ${txEvent.attributes['TokenOne']},
      ${txEvent.attributes['TickIndex']},
      ${txEvent.attributes['Fee']},
      ${txEvent.attributes['ReservesZeroWithdrawn']},
      ${txEvent.attributes['ReservesOneWithdrawn']},
      ${txEvent.attributes['SharesRemoved']},

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
      (${selectSortedPairID(
        txEvent.attributes['TokenZero'],
        txEvent.attributes['TokenOne']
      )})
    )
    `)
  );
}
