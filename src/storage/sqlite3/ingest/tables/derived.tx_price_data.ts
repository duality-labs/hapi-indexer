import sql from 'sql-template-tag';
import { TxResponse } from '../../../../@types/tx';

import db, { prepare } from '../../db/db';
import getLatestTickStateCTE from '../../db/derived.tick_state/getLatestDerivedTickState';

import { DecodedTxEvent } from '../utils/decodeEvent';
import Timer from '../../../../utils/timer';

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

  if (isDexMessage && txEvent.attributes.action === 'TickUpdate') {
    const isForward =
      txEvent.attributes['TokenIn'] === txEvent.attributes['Token1'];
    const tickSide = isForward ? 'LowestTick1' : 'HighestTick0';
    // note that previousTickIndex may not exist yet
    timer.start('processing:txs:derived.tx_price_data:get:tx_price_data');
    const previousPriceData = await db.get(
      ...prepare(sql`
      SELECT
        'derived.tx_price_data'.'HighestTick0',
        'derived.tx_price_data'.'LowestTick1'
      FROM
        'derived.tx_price_data'
      WHERE (
        'derived.tx_price_data'.'related.dex.pair' = (
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
      ORDER BY
        'derived.tx_price_data'.'related.tx_result.events' DESC
      LIMIT 1
      `)
    );
    const previousTickIndex = previousPriceData?.[tickSide];
    timer.stop('processing:txs:derived.tx_price_data:get:tx_price_data');

    timer.start('processing:txs:derived.tx_price_data:get:tick_state');
    // derive data from entire ticks state (useful for maybe some other calculations)
    const currentTickIndex = await db
      .get(
        ...prepare(sql`
          WITH 'latest.derived.tick_state' AS (${getLatestTickStateCTE(
            txEvent.attributes['Token0'],
            txEvent.attributes['Token1'],
            txEvent.attributes['TokenIn'],
            { fromHeight: 0, toHeight: Number(tx_result.height) }
          )})
          SELECT
            'latest.derived.tick_state'.'TickIndex'
          FROM
            'latest.derived.tick_state'
          WHERE
            'latest.derived.tick_state'.'Reserves' != '0'
          ORDER BY 'latest.derived.tick_state'.'TickIndex' ${
            isForward ? sql`ASC` : sql`DESC`
          }
          LIMIT 1
        `)
      )
      .then((row) => row?.['TickIndex'] ?? null);
    timer.stop('processing:txs:derived.tx_price_data:get:tick_state');

    // if activity has changed current price then update data
    if (previousTickIndex !== currentTickIndex) {
      const previousOtherSideTickIndex =
        (isForward
          ? previousPriceData?.['HighestTick0']
          : previousPriceData?.['LowestTick1']) ?? null;
      timer.start('processing:txs:derived.tx_price_data:set:tx_price_data');
      await db.run(
        ...prepare(sql`
        INSERT OR REPLACE INTO 'derived.tx_price_data' (

          'HighestTick0',
          'LowestTick1',
          'LastTick',

          'related.tx_result.events',
          'related.dex.pair'

        ) values (

          ${isForward ? previousOtherSideTickIndex : currentTickIndex},
          ${isForward ? currentTickIndex : previousOtherSideTickIndex},
          ${currentTickIndex || previousOtherSideTickIndex || null},

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
      timer.stop('processing:txs:derived.tx_price_data:set:tx_price_data');
    }
  }
}
