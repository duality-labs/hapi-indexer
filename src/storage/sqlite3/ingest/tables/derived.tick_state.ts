import sql from 'sql-template-tag';
import { TxResponse } from '../../../../@types/tx';

import db, { prepare } from '../../db/db';

import { isDexTickUpdate, isDexTrancheUpdate } from '../utils/utils';
import { DecodedTxEvent } from '../utils/decodeEvent';
import Timer from '../../../../utils/timer';
import { selectTokenID } from '../../db/dex.tokens/selectTokenID';
import { selectSortedPairID } from '../../db/dex.pairs/selectPairID';
import type { DerivedTickUpdateAttributes } from './event.TickUpdate';

export default async function upsertDerivedTickStateRows(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent & { derived: DerivedTickUpdateAttributes },
  index: number,
  timer = new Timer()
) {
  // consider all non-tranche tick updates in tracked liquidity state
  if (
    tx_result.code === 0 &&
    isDexTickUpdate(txEvent) &&
    !isDexTrancheUpdate(txEvent)
  ) {
    // check if this data is not an update and exit early
    if (!Number(txEvent.derived['ReservesDiff'])) {
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

    return lastID;
  }
}
