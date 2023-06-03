import sql from 'sql-template-strings';
import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';

import db from '../../db/db';

import { getBlockTimeFromTxResult } from './block';

import { DecodedTxEvent } from '../utils/decodeEvent';

export async function upsertDerivedTickStateRows(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number
) {
  const isDexMessage =
    txEvent.type === 'TickUpdate' &&
    txEvent.attributes.module === 'dex' &&
    tx_result.code === 0;

  if (isDexMessage && txEvent.attributes.action === 'TickUpdate') {
    const blockTime = getBlockTimeFromTxResult(tx_result);

    const previousStateData = await db.get(sql`
      SELECT 'derived.tick_state'.'Reserves'
      FROM 'derived.tick_state'
      WHERE (
        'derived.tick_state'.'meta.dex.pair' = (
          SELECT
            'dex.pairs'.'id'
          FROM
            'dex.pairs'
          WHERE (
            'dex.pairs'.'Token0' = ${txEvent.attributes['Token0']} AND
            'dex.pairs'.'Token1' = ${txEvent.attributes['Token1']}
          )
        ) AND
        'derived.tick_state'.'meta.dex.token' = (
          SELECT
            'dex.tokens'.'id'
          FROM
            'dex.tokens'
          WHERE (
            'dex.tokens'.'Token' = ${txEvent.attributes['TokenIn']}
          )
        ) AND
        'derived.tick_state'.'TickIndex' = ${txEvent.attributes['TickIndex']}
      )
    `);

    // check if this data is not an update and exit early
    if (
      previousStateData &&
      previousStateData['Reserves'] === txEvent.attributes['Reserves']
    ) {
      return;
    }

    const { lastID } = await db.run(sql`
      INSERT OR REPLACE INTO 'derived.tick_state' (
        'meta.dex.pair',
        'meta.dex.token',
        'TickIndex',
        'Reserves'
      ) values (
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
        ${txEvent.attributes['TickIndex']},
        ${txEvent.attributes['Reserves']}
      )
    `);

    // continue logic for several dependent states
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
        'derived.tx_price_data'.'meta.dex.pair' = (
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
        'derived.tx_price_data'.'block.header.height' DESC,
        'derived.tx_price_data'.'tx.index' DESC,
        'derived.tx_price_data'.'tx_result.events.index' DESC
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
            'derived.tick_state'.'meta.dex.pair' = (
              SELECT
                'dex.pairs'.'id'
              FROM
                'dex.pairs'
              WHERE (
                'dex.pairs'.'Token0' = ${txEvent.attributes['Token0']} AND
                'dex.pairs'.'Token1' = ${txEvent.attributes['Token1']}
              )
            ) AND
            'derived.tick_state'.'meta.dex.token' = (
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
          'block.header.height',
          'block.header.time_unix',
          'tx.index',
          'tx_result.events.index',

          'meta.dex.pair',

          'HighestTick0',
          'LowestTick1',
          'LastTick'
        ) values (
          ${tx_result.height},
          ${blockTime},
          ${
            // we use a negative index here to keep a reference
            // but not use it as a JOIN-able link as its not real data
            -index
          },
          ${txEvent.index},

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

          ${isForward ? previousOtherSideTickIndex : currentTickIndex},
          ${isForward ? currentTickIndex : previousOtherSideTickIndex},
          ${currentTickIndex || previousOtherSideTickIndex}
        )
      `);
    }

    return lastID;
  }
}
