import sql from 'sql-template-tag';
import { TxResponse } from '../../../../@types/tx';

import db, { prepare } from '../../db/db';

import { isDexTickUpdate, isDexTrancheUpdate } from '../utils/utils';
import { DecodedTxEvent } from '../utils/decodeEvent';
import Timer from '../../../../utils/timer';
import { selectSortedPairID } from '../../db/dex.pairs/selectPairID';
import { DerivedTickUpdateAttributes } from './event.TickUpdate';

export default async function upsertDerivedVolumeData(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent & { derived: DerivedTickUpdateAttributes },
  index: number,
  timer = new Timer()
) {
  // consider all non-tranche tick updates in TVL movements
  if (
    tx_result.code === 0 &&
    isDexTickUpdate(txEvent) &&
    !isDexTrancheUpdate(txEvent)
  ) {
    const isForward =
      txEvent.attributes['TokenIn'] === txEvent.attributes['TokenOne'];
    const inColumn = isForward ? 'ReservesFloat1' : 'ReservesFloat0';
    const outColumn = !isForward ? 'ReservesFloat1' : 'ReservesFloat0';
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
    timer.stop('processing:txs:derived.tx_volume_data:get:tx_volume_data');

    // calculate new reserves from previous value and this update diff
    // todo: the accuracy of this value is limited by floating point math
    //       the 'derived.tx_volume_data'.'ReservesFloat' column could be better
    const currentInSideReserves = Math.max(
      Number(previousData?.[inColumn] ?? 0) +
        Number(txEvent.derived['ReservesDiff']),
      0
    );

    // if activity has changed current reserves then update data
    if (Number(txEvent.derived['ReservesDiff']) !== 0) {
      const previousOutSideReserves = previousData?.[outColumn] ?? 0;
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

          ${isForward ? previousOutSideReserves : currentInSideReserves},
          ${isForward ? currentInSideReserves : previousOutSideReserves},

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
