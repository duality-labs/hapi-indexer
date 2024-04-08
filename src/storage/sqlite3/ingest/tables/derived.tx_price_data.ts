import sql from 'sql-template-tag';
import { TxResponse } from '../../../../@types/tx';

import db, { prepare } from '../../db/db';

import { isDexSwapTickUpdate } from '../utils/utils';
import { DecodedTxEvent } from '../utils/decodeEvent';
import Timer from '../../../../utils/timer';
import { selectSortedPairID } from '../../db/dex.pairs/selectPairID';
import type { DerivedTickUpdateAttributes } from './event.TickUpdate';

export default async function upsertDerivedPriceData(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent & { derived: DerivedTickUpdateAttributes },
  index: number,
  timer = new Timer()
) {
  // only consider "swap" TickUpdates for price movements
  if (tx_result.code === 0 && isDexSwapTickUpdate(txEvent, tx_result)) {
    const isForward =
      txEvent.attributes['TokenIn'] === txEvent.attributes['TokenOne'];

    // get current (normalized) tick index from event
    const currentTickIndex: number | null = txEvent.attributes['TickIndex']
      ? Number(txEvent.attributes['TickIndex']) * (isForward ? 1 : -1)
      : null;

    // if activity has a current price then update data
    if (currentTickIndex !== null) {
      timer.start('processing:txs:derived.tx_price_data:set:tx_price_data');
      await db.run(
        ...prepare(sql`
        INSERT OR REPLACE INTO 'derived.tx_price_data' (

          -- NormalizedTickIndex is TickIndex1To0
          'LastTickIndex1To0',

          'related.tx_result.events',
          'related.dex.pair'

        ) values (

          ${currentTickIndex},

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
      timer.stop('processing:txs:derived.tx_price_data:set:tx_price_data');
    }
  }
}
