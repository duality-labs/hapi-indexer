import sql from 'sql-template-strings';
import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';

import db from '../../db/db';
import { getBlockTimeFromTxResult } from './block';

import { BaseDexEventAttributeMap, DecodedTxEvent } from '../utils/eventTypes';

export interface TickUpdateEventAttributeMap extends BaseDexEventAttributeMap<'TickUpdate'> {
  Token0: string;
  Token1: string;
  TokenIn: string;
  TickIndex: string;
  Reserves: string;
}

export default async function insertEventTickUpdate(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent<TickUpdateEventAttributeMap>,
  index: number
) {
  return await db.run(sql`
    INSERT INTO 'event.TickUpdate' (
      'block.header.height',
      'block.header.time_unix',
      'tx.index',
      'tx_result.events.index',

      'Token0',
      'Token1',
      'TokenIn',
      'TickIndex',
      'Reserves',

      'meta.dex.pair',
      'meta.dex.token'
    ) values (
      ${tx_result.height},
      ${getBlockTimeFromTxResult(tx_result)},
      ${index},
      ${txEvent.index},

      ${txEvent.attributes['Token0']},
      ${txEvent.attributes['Token1']},
      ${txEvent.attributes['TokenIn']},
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
}
