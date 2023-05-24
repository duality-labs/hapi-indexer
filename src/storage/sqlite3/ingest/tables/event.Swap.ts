import sql from 'sql-template-strings';
import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';

import db from '../../db/db';
import { getBlockTimeFromTxResult } from './block';

import { BaseDexEventAttributeMap, DecodedTxEvent } from '../utils/eventTypes';

export interface SwapEventAttributeMap extends BaseDexEventAttributeMap<'Swap'> {
  Creator: string;
  Receiver: string;
  Token0: string;
  Token1: string;
  TokenIn: string;
  AmountIn: string;
  AmountOut: string;
}

export default async function insertEventSwap(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent<SwapEventAttributeMap>,
  index: number
) {
  return await db.run(sql`
    INSERT INTO 'event.Swap' (
      'block.header.height',
      'block.header.time_unix',
      'tx.index',
      'tx_result.events.index',

      'Creator',
      'Receiver',
      'Token0',
      'Token1',
      'TokenIn',
      'TokenOut',
      'AmountIn',
      'AmountOut',

      'meta.dex.pair',
      'meta.dex.tokenIn',
      'meta.dex.tokenOut'
    ) values (
      ${tx_result.height},
      ${getBlockTimeFromTxResult(tx_result)},
      ${index},
      ${txEvent.index},

      ${txEvent.attributes['Creator']},
      ${txEvent.attributes['Receiver']},
      ${txEvent.attributes['Token0']},
      ${txEvent.attributes['Token1']},
      ${txEvent.attributes['TokenIn']},
      ${
        // derive TokenOut
        txEvent.attributes['TokenIn'] !== txEvent.attributes['Token0']
          ? txEvent.attributes['Token0']
          : txEvent.attributes['Token1']
      },
      ${txEvent.attributes['AmountIn']},
      ${txEvent.attributes['AmountOut']},

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
      (
        SELECT
          'dex.tokens'.'id'
        FROM
          'dex.tokens'
        WHERE (
          'dex.tokens'.'Token' = ${
            // derive TokenOut
            txEvent.attributes['TokenIn'] !== txEvent.attributes['Token0']
              ? txEvent.attributes['Token0']
              : txEvent.attributes['Token1']
          }
        )
      )
    )
  `);
}
