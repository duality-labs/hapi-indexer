import sql from 'sql-template-strings';
import { TxResponse } from '../../../../@types/tx';

import db from '../../db/db';

import upsertDerivedPriceData from './derived.tx_price_data';
import upsertDerivedVolumeData from './derived.tx_volume_data';

import { DecodedTxEvent } from '../utils/decodeEvent';

export async function upsertDerivedTickStateRows(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent
) {
  const isDexMessage =
    txEvent.type === 'TickUpdate' &&
    txEvent.attributes.module === 'dex' &&
    tx_result.code === 0;

  if (isDexMessage && txEvent.attributes.action === 'TickUpdate') {
    // get previous state to compare against
    const previousStateData = await db.get(sql`
      SELECT 'derived.tick_state'.'Reserves'
      FROM 'derived.tick_state'
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
        'TickIndex',
        'Reserves',

        'related.dex.pair',
        'related.dex.token'
      ) values (

        ${txEvent.attributes['TickIndex']},
        ${txEvent.attributes['Reserves']},

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
        )
      )
    `);

    // continue logic for several dependent states
    await Promise.all([
      upsertDerivedPriceData(tx_result, txEvent),
      upsertDerivedVolumeData(tx_result, txEvent),
    ]);

    return lastID;
  }
}
