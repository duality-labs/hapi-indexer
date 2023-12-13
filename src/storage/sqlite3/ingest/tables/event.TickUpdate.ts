import BigNumber from 'bignumber.js';
import sql from 'sql-template-tag';
import { TxResponse } from '../../../../@types/tx';

import db, { prepare } from '../../db/db';

import { DecodedTxEvent } from '../utils/decodeEvent';
import Timer from '../../../../utils/timer';
import { selectTokenID } from '../../db/dex.tokens/selectTokenID';
import { selectSortedPairID } from '../../db/dex.pairs/selectPairID';

export default async function insertEventTickUpdate(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number,
  timer = new Timer()
) {
  timer.start('processing:txs:event.TickUpdate:get:event.TickUpdate');
  const previousTickUpdate = await db.get<{ Reserves: string }>(
    ...prepare(sql`
    SELECT
      'event.TickUpdate'.'Reserves'
    FROM
      'event.TickUpdate'
    WHERE (
      'event.TickUpdate'.'TokenZero' = ${txEvent.attributes['TokenZero']} AND
      'event.TickUpdate'.'TokenOne' = ${txEvent.attributes['TokenOne']} AND
      'event.TickUpdate'.'TokenIn' = ${txEvent.attributes['TokenIn']} AND
      'event.TickUpdate'.'TickIndex' = ${txEvent.attributes['TickIndex']}
    )
    ORDER BY
      'event.TickUpdate'.'related.tx_result.events' DESC
    LIMIT 1
    `)
  );
  timer.stop('processing:txs:event.TickUpdate:get:event.TickUpdate');

  const previousReserves = previousTickUpdate?.['Reserves'] || '0';
  const currentReserves = txEvent.attributes['Reserves'] || '0';

  if (currentReserves === previousReserves) {
    // skip adding of non-update
    return;
  }

  timer.start('processing:txs:event.TickUpdate:set:event.TickUpdate');
  await db.run(
    ...prepare(sql`
    INSERT INTO 'event.TickUpdate' (

      'TokenZero',
      'TokenOne',
      'TokenIn',
      'TickIndex',
      'Reserves',
      'Fee',

      'derived.ReservesDiff',

      'related.tx_result.events',
      'related.dex.pair',
      'related.dex.token'
    ) values (

      ${txEvent.attributes['TokenZero']},
      ${txEvent.attributes['TokenOne']},
      ${txEvent.attributes['TokenIn']},
      ${txEvent.attributes['TickIndex']},
      ${txEvent.attributes['Reserves']},
      ${
        Number(txEvent.attributes['Fee']) >= 0
          ? txEvent.attributes['Fee']
          : null
      },

      -- derive the difference in reserves from the previous tick state
      ${
        previousReserves !== '0'
          ? new BigNumber(txEvent.attributes['Reserves'])
              .minus(previousReserves)
              .toFixed(0)
          : txEvent.attributes['Reserves']
      },
  
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
      (${selectTokenID(txEvent.attributes['TokenIn'])})
    )
    `)
  );
  timer.stop('processing:txs:event.TickUpdate:set:event.TickUpdate');
}
