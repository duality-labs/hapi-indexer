import sql from 'sql-template-tag';
import { TxResponse } from '../../../../@types/tx';

import db, { prepare } from '../../db/db';

import decodeEvent, { DecodedTxEvent } from '../utils/decodeEvent';
import Timer from '../../../../utils/timer';
import { selectSortedPairID } from '../../db/dex.pairs/selectPairID';

export default async function upsertDerivedPriceData(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number,
  timer = new Timer()
) {
  // repeat basic Dex event check
  const isDexMessage =
    tx_result.code === 0 && txEvent.attributes.module === 'dex';

  // only consider TickUpdates for price movements
  const isDexTickUpdate =
    isDexMessage &&
    txEvent.type === 'TickUpdate' &&
    txEvent.attributes.action === 'TickUpdate';

  // only consider TickUpdates from PlaceLimitOrder actions as price movements
  const isDexTxMsgPlaceLimitOrder =
    isDexTickUpdate &&
    (tx_result.events || [])
      .filter((txEvent) => txEvent.type === 'message')
      .map(decodeEvent)
      .find(
        (txDecodedEvent) =>
          txDecodedEvent.attributes['action'] === 'PlaceLimitOrder'
      );

  if (isDexMessage && isDexTickUpdate && isDexTxMsgPlaceLimitOrder) {
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
