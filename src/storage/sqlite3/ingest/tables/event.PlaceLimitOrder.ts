import sql from 'sql-template-strings';
import { TxResponse } from '../../../../@types/tx';

import db from '../../db/db';

import { DecodedTxEvent } from '../utils/decodeEvent';

export default async function insertEventPlaceLimitOrder(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number
) {
  return await db.run(sql`
    INSERT INTO 'event.PlaceLimitOrder' (

      'Creator',
      'Receiver',
      'Token0',
      'Token1',
      'TokenIn',
      'TokenOut',
      'AmountIn',
      'LimitTick',
      'OrderType',
      'Shares',
      'TrancheKey',

      'related.tx_result.events',
      'related.dex.pair',
      'related.dex.tokenIn',
      'related.dex.tokenOut'
    ) values (

      ${txEvent.attributes['Creator']},
      ${txEvent.attributes['Receiver']},
      ${txEvent.attributes['Token0']},
      ${txEvent.attributes['Token1']},
      ${txEvent.attributes['TokenIn']},
      ${
        // derive TokenOut
        txEvent.attributes['TokenIn'] !== txEvent.attributes['Token0']
          ? txEvent.attributes['Token0']
          : txEvent.attributes['Token1']
      },
      ${txEvent.attributes['AmountIn']},
      ${txEvent.attributes['LimitTick']},
      ${txEvent.attributes['OrderType']},
      ${txEvent.attributes['Shares']},
      ${txEvent.attributes['TrancheKey']},

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
      (
        SELECT
          'dex.tokens'.'id'
        FROM
          'dex.tokens'
        WHERE (
          'dex.tokens'.'Token' = ${
            // derive TokenOut
            txEvent.attributes['TokenIn'] !== txEvent.attributes['Token0']
              ? txEvent.attributes['Token0']
              : txEvent.attributes['Token1']
          }
        )
      )
    )
  `);
}
