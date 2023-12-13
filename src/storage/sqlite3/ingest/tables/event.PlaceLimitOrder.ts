import sql from 'sql-template-tag';
import { TxResponse } from '../../../../@types/tx';

import db, { prepare } from '../../db/db';

import { DecodedTxEvent } from '../utils/decodeEvent';
import { selectTokenID } from '../../db/dex.tokens/selectTokenID';
import { selectSortedPairID } from '../../db/dex.pairs/selectPairID';

export default async function insertEventPlaceLimitOrder(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number
) {
  return await db.run(
    ...prepare(sql`
    INSERT INTO 'event.PlaceLimitOrder' (

      'Creator',
      'Receiver',
      'TokenZero',
      'TokenOne',
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
      ${txEvent.attributes['TokenZero']},
      ${txEvent.attributes['TokenOne']},
      ${txEvent.attributes['TokenIn']},
      ${
        // derive TokenOut
        txEvent.attributes['TokenIn'] !== txEvent.attributes['TokenZero']
          ? txEvent.attributes['TokenZero']
          : txEvent.attributes['TokenOne']
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
      (${selectSortedPairID(
        txEvent.attributes['TokenZero'],
        txEvent.attributes['TokenOne']
      )}),
      (${selectTokenID(txEvent.attributes['TokenIn'])}),
      (${selectTokenID(
        // derive TokenOut
        txEvent.attributes['TokenIn'] !== txEvent.attributes['TokenZero']
          ? txEvent.attributes['TokenZero']
          : txEvent.attributes['TokenOne']
      )}
      )
    )
    `)
  );
}
