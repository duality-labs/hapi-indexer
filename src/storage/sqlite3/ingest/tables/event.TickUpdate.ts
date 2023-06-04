import sql from 'sql-template-strings';
import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';

import db from '../../db/db';

import { DecodedTxEvent } from '../utils/decodeEvent';

export default async function insertEventTickUpdate(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number,
  {
    lastEventDepositID,
    lastEventWithdrawID,
    lastEventPlaceLimitOrderID,
  }: Record<string, number | false | undefined> = {}
) {
  return await db.run(sql`
    INSERT INTO 'event.TickUpdate' (

      'Token0',
      'Token1',
      'TokenIn',
      'TickIndex',
      'Reserves',

      'related.tx_result.events',
      'related.dex.pair',
      'related.dex.token',
      'related.event.Deposit',
      'related.event.Withdraw',
      'related.event.PlaceLimitOrder'
    ) values (

      ${txEvent.attributes['Token0']},
      ${txEvent.attributes['Token1']},
      ${txEvent.attributes['TokenIn']},
      ${txEvent.attributes['TickIndex']},
      ${txEvent.attributes['Reserves']},

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
          'dex.pairs'.'Token0' = ${txEvent.attributes['Token0']} AND
          'dex.pairs'.'Token1' = ${txEvent.attributes['Token1']}
        )
      ),
      (
        SELECT
          'dex.tokens'.'id'
        FROM
          'dex.tokens'
        WHERE (
          'dex.tokens'.'Token' = ${txEvent.attributes['TokenIn']}
        )
      ),
      ${lastEventDepositID || null},
      ${lastEventWithdrawID || null},
      ${lastEventPlaceLimitOrderID || null}
    )
  `);
}
