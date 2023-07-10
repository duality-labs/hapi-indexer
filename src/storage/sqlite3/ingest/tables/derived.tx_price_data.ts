import sql from 'sql-template-strings';
import { TxResponse } from '../../../../@types/tx';

import db from '../../db/db';

import { DecodedTxEvent } from '../utils/decodeEvent';

export default async function upsertDerivedPriceData(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number
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
    const previousPriceData = await db.get(sql`
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
            'dex.pairs'.'Token0' = ${txEvent.attributes['Token0']} AND
            'dex.pairs'.'Token1' = ${txEvent.attributes['Token1']}
          )
        )
      )
      ORDER BY
        'derived.tx_price_data'.'related.tx_result.events' DESC
      LIMIT 1
    `);
    const previousTickIndex = previousPriceData?.[tickSide];

    // derive data from entire ticks state (useful for maybe some other calculations)
    const currentTickIndex = await db
      .get(
        // append plain SQL (without value substitution) to have conditional query
        sql`
          SELECT
            'derived.tick_state'.'TickIndex'
          FROM
            'derived.tick_state'
          WHERE (
            'derived.tick_state'.'related.dex.pair' = (
              SELECT
                'dex.pairs'.'id'
              FROM
                'dex.pairs'
              WHERE (
                'dex.pairs'.'Token0' = ${txEvent.attributes['Token0']} AND
                'dex.pairs'.'Token1' = ${txEvent.attributes['Token1']}
              )
            ) AND
            'derived.tick_state'.'related.dex.token' = (
              SELECT
                'dex.tokens'.'id'
              FROM
                'dex.tokens'
              WHERE (
                'dex.tokens'.'Token' = ${txEvent.attributes['TokenIn']}
              )
            ) AND
            'derived.tick_state'.'Reserves' != '0'
          )
        `.append(`--sql
          ORDER BY 'derived.tick_state'.'TickIndex' ${
            isForward ? 'ASC' : 'DESC'
          }
          LIMIT 1
        `)
      )
      .then((row) => row?.['TickIndex'] ?? null);

    // if activity has changed current price then update data
    if (previousTickIndex !== currentTickIndex) {
      const previousOtherSideTickIndex =
        (isForward
          ? previousPriceData?.['HighestTick0']
          : previousPriceData?.['LowestTick1']) ?? null;
      await db.run(sql`
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
              'dex.pairs'.'Token0' = ${txEvent.attributes['Token0']} AND
              'dex.pairs'.'Token1' = ${txEvent.attributes['Token1']}
            )
          )
        )
      `);
    }
  }
}
