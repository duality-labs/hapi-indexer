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
  // repeat checks
  const isDexMessage =
    txEvent.type === 'TickUpdate' &&
    txEvent.attributes.module === 'dex' &&
    tx_result.code === 0;

  // only consider TickUpdates for price movements
  const isDexTickUpdate =
    isDexMessage && txEvent.attributes.action === 'TickUpdate';

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
    // note that previousTickIndex may not exist yet
    timer.start('processing:txs:derived.tx_price_data:get:tx_price_data');
    const previousPriceData = await db.get(
      ...prepare(sql`
      SELECT
        'derived.tx_price_data'.'HighestNormalizedTickIndex0',
        'derived.tx_price_data'.'LowestNormalizedTickIndex1'
      FROM
        'derived.tx_price_data'
      WHERE (
        'derived.tx_price_data'.'related.dex.pair' = (${selectSortedPairID(
          txEvent.attributes['TokenZero'],
          txEvent.attributes['TokenOne']
        )})
      )
      ORDER BY
        'derived.tx_price_data'.'related.tx_result.events' DESC
      LIMIT 1
      `)
    );
    timer.stop('processing:txs:derived.tx_price_data:get:tx_price_data');

    // derive data from entire ticks state (useful for maybe some other calculations)
    const currentTickIndex: number | null = txEvent.attributes['TickIndex']
      ? Number(txEvent.attributes['TickIndex']) * (isForward ? 1 : -1)
      : null;

    // if activity has a current price then update data
    if (currentTickIndex !== null) {
      const previousOtherSideTickIndex =
        (isForward
          ? previousPriceData?.['HighestNormalizedTickIndex0']
          : previousPriceData?.['LowestNormalizedTickIndex1']) ?? null;
      timer.start('processing:txs:derived.tx_price_data:set:tx_price_data');
      await db.run(
        ...prepare(sql`
        INSERT OR REPLACE INTO 'derived.tx_price_data' (

          'HighestNormalizedTickIndex0',
          'LowestNormalizedTickIndex1',
          -- NormalizedTickIndex is TickIndex1To0
          'LastTickIndex1To0',

          'related.tx_result.events',
          'related.dex.pair'

        ) values (

          ${isForward ? previousOtherSideTickIndex : currentTickIndex},
          ${isForward ? currentTickIndex : previousOtherSideTickIndex},
          ${currentTickIndex ?? previousOtherSideTickIndex ?? null},

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
