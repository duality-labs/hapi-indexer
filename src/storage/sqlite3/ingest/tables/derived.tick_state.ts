import sql from 'sql-template-strings';
import { TxResponse } from '../../../../@types/tx';

import db from '../../db/db';
import getLatestTickStateCTE from '../../db/derived.tick_state/getLatestDerivedTickState';

import upsertDerivedPriceData from './derived.tx_price_data';
import upsertDerivedVolumeData from './derived.tx_volume_data';

import { DecodedTxEvent } from '../utils/decodeEvent';
import Timer from '../../../../utils/timer';

export async function upsertDerivedTickStateRows(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number,
  timer = new Timer()
) {
  const isDexMessage =
    txEvent.type === 'TickUpdate' &&
    txEvent.attributes.module === 'dex' &&
    tx_result.code === 0;

  if (isDexMessage && txEvent.attributes.action === 'TickUpdate') {
    // get previous state to compare against
    timer.start('processing:txs:derived.tick_state:get:tick_state');
    const previousStateData = await db.get(
      getLatestTickStateCTE(
        txEvent.attributes['Token0'],
        txEvent.attributes['Token1'],
        txEvent.attributes['TokenIn'],
        { fromHeight: 0, toHeight: Number(tx_result.height) }
      ).append(sql`
        SELECT 'latest.derived.tick_state'.'Reserves'
        FROM 'latest.derived.tick_state'
        WHERE (
          'latest.derived.tick_state'.'TickIndex' = ${txEvent.attributes['TickIndex']}
        )
        ORDER BY 'latest.derived.tick_state'.'related.block.header.height' DESC
        LIMIT 1
      `)
    );

    // check if this data is not an update and exit early
    if (
      previousStateData &&
      previousStateData['Reserves'] === txEvent.attributes['Reserves']
    ) {
      return;
    }
    timer.stop('processing:txs:derived.tick_state:get:tick_state');

    timer.start('processing:txs:derived.tick_state:set:tick_state');
    const { lastID } = await db.run(sql`
      INSERT OR REPLACE INTO 'derived.tick_state' (
        'TickIndex',
        'Reserves',

        'related.dex.pair',
        'related.dex.token',
        'related.block.header.height'
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
        ),
        ${tx_result.height}
      )
    `);
    timer.stop('processing:txs:derived.tick_state:set:tick_state');

    // continue logic for several dependent states
    await Promise.all([
      upsertDerivedPriceData(tx_result, txEvent, index, timer),
      upsertDerivedVolumeData(tx_result, txEvent, index, timer),
    ]);

    return lastID;
  }
}
