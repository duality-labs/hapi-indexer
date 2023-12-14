import sql from 'sql-template-tag';
import { TxResponse } from '../../../../@types/tx';

import db, { prepare } from '../../db/db';
import selectLatestTickState from '../../db/derived.tick_state/selectLatestDerivedTickState';

import upsertDerivedPriceData from './derived.tx_price_data';
import upsertDerivedVolumeData from './derived.tx_volume_data';

import { DecodedTxEvent } from '../utils/decodeEvent';
import Timer from '../../../../utils/timer';
import { selectTokenID } from '../../db/dex.tokens/selectTokenID';
import { selectSortedPairID } from '../../db/dex.pairs/selectPairID';

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
      ...prepare(sql`
        WITH 'latest.derived.tick_state' AS (${selectLatestTickState(
          txEvent.attributes['TokenZero'],
          txEvent.attributes['TokenOne'],
          txEvent.attributes['TokenIn'],
          { fromHeight: 0, toHeight: Number(tx_result.height) }
        )})
        SELECT 'latest.derived.tick_state'.'Reserves'
        FROM 'latest.derived.tick_state'
        WHERE (
          'latest.derived.tick_state'.'TickIndex' = ${
            txEvent.attributes['TickIndex']
          }
        ) AND (
          'latest.derived.tick_state'.'Fee' = ${txEvent.attributes['Fee']}
        )
        ORDER BY 'latest.derived.tick_state'.'related.block.header.height' DESC
        LIMIT 1
      `)
    );
    timer.stop('processing:txs:derived.tick_state:get:tick_state');

    // check if this data is not an update and exit early
    if (
      previousStateData &&
      previousStateData['Reserves'] === txEvent.attributes['Reserves']
    ) {
      return;
    }

    timer.start('processing:txs:derived.tick_state:set:tick_state');
    const { lastID } = await db.run(
      ...prepare(sql`
      INSERT OR REPLACE INTO 'derived.tick_state' (
        'TickIndex',
        'Fee',
        'Reserves',

        'related.dex.pair',
        'related.dex.token',
        'related.block.header.height'
      ) values (

        ${txEvent.attributes['TickIndex']},
        ${txEvent.attributes['Fee']},
        ${txEvent.attributes['Reserves']},

        (${selectSortedPairID(
          txEvent.attributes['TokenZero'],
          txEvent.attributes['TokenOne']
        )}),
        (${selectTokenID(txEvent.attributes['TokenIn'])}),
        ${tx_result.height}
      )
      `)
    );
    timer.stop('processing:txs:derived.tick_state:set:tick_state');

    // continue logic for several dependent states
    await Promise.all([
      upsertDerivedPriceData(tx_result, txEvent, index, timer),
      upsertDerivedVolumeData(tx_result, txEvent, index, timer),
    ]);

    return lastID;
  }
}
