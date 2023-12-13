import sql from 'sql-template-tag';
import { TxResponse } from '../../../../@types/tx';

import db, { prepare } from '../../db/db';
import selectLatestTickState from '../../db/derived.tick_state/selectLatestDerivedTickState';

import { DecodedTxEvent } from '../utils/decodeEvent';
import Timer from '../../../../utils/timer';
import { selectSortedPairID } from '../../db/dex.pairs/selectPairID';

export default async function upsertDerivedVolumeData(
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

  if (isDexMessage && txEvent.attributes.action === 'TickUpdate') {
    const isForward =
      txEvent.attributes['TokenIn'] === txEvent.attributes['TokenOne'];
    const queriedColumn = isForward ? 'ReservesFloat1' : 'ReservesFloat0';
    const otherColumn = !isForward ? 'ReservesFloat1' : 'ReservesFloat0';
    // note that previousReserves may not exist yet
    timer.start('processing:txs:derived.tx_volume_data:get:tx_volume_data');
    const previousData = await db.get(
      ...prepare(sql`
      SELECT
        'derived.tx_volume_data'.'ReservesFloat0',
        'derived.tx_volume_data'.'ReservesFloat1'
      FROM
        'derived.tx_volume_data'
      WHERE (
        'derived.tx_volume_data'.'related.dex.pair' = (${selectSortedPairID(
          txEvent.attributes['TokenZero'],
          txEvent.attributes['TokenOne']
        )})
      )
      ORDER BY
        'derived.tx_volume_data'.'related.tx_result.events' DESC
      LIMIT 1
      `)
    );
    const previousReserves = previousData?.[queriedColumn];
    timer.stop('processing:txs:derived.tx_volume_data:get:tx_volume_data');

    timer.start('processing:txs:derived.tx_volume_data:get:tick_state');
    // derive data from entire ticks state (useful for maybe some other calculations)
    const currentReserves = await db
      .get(
        ...prepare(sql`
          WITH 'latest.derived.tick_state' AS (${selectLatestTickState(
            txEvent.attributes['TokenZero'],
            txEvent.attributes['TokenOne'],
            txEvent.attributes['TokenIn'],
            { fromHeight: 0, toHeight: Number(tx_result.height) }
          )})
          SELECT
            -- get all token reserves of a token in a pair (as a float for ease)
            SUM( CAST('latest.derived.tick_state'.'Reserves' AS FLOAT) ) as 'ReservesFloat'
          FROM
            'latest.derived.tick_state'
          WHERE (
            'latest.derived.tick_state'.'Reserves' != '0'
          )
          GROUP BY
            'latest.derived.tick_state'.'related.dex.pair',
            'latest.derived.tick_state'.'related.dex.token'
        `)
      )
      .then((row) => row?.['ReservesFloat'] ?? null);
    timer.stop('processing:txs:derived.tx_volume_data:get:tick_state');

    // if activity has changed current reserves then update data
    if (previousReserves !== currentReserves) {
      const previousOtherSideReserves = previousData?.[otherColumn] ?? 0;
      timer.start('processing:txs:derived.tx_volume_data:set:tx_volume_data');
      await db.run(
        ...prepare(sql`
        INSERT OR REPLACE INTO 'derived.tx_volume_data' (
          'ReservesFloat0',
          'ReservesFloat1',

          'related.tx_result.events',
          'related.dex.pair',
          'related.block.header.height'
        ) values (

          ${isForward ? previousOtherSideReserves : currentReserves},
          ${isForward ? currentReserves : previousOtherSideReserves},

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
          ${tx_result.height}
        )
        `)
      );
      timer.stop('processing:txs:derived.tx_volume_data:set:tx_volume_data');
    }
  }
}
