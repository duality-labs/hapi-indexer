import sql from 'sql-template-strings';
import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';

import db from '../../db/db';

import insertDexPairsRows from './dex.pairs';

import { DecodedTxEvent } from '../utils/decodeEvent';

export default async function insertTxEventRows(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number,
  lastMsgID: number | undefined
) {
  const isDexMessage =
    tx_result.code === 0 &&
    txEvent.attributes.module === 'dex' &&
    (txEvent.type === 'message' || txEvent.type === 'TickUpdate');
  const dexPairId =
    isDexMessage && txEvent.attributes.Token0 && txEvent.attributes.Token1
      ? await insertDexPairsRows(txEvent)
      : undefined;

  const { lastID } = await db.run(sql`
    INSERT INTO 'tx_result.events' (
      'index',
      'type',
      'attributes',

      'related.tx',
      'related.dex.pair_swap',
      'related.dex.pair_deposit',
      'related.dex.pair_withdraw',
      'related.tx_msg'
    ) values (

      ${txEvent.index},
      ${txEvent.type},
      ${JSON.stringify(txEvent.attributes)},

      (
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
      ),
      ${
        isDexMessage &&
        txEvent.attributes.action === 'PlaceLimitOrder' &&
        dexPairId
      },
      ${isDexMessage && txEvent.attributes.action === 'Deposit' && dexPairId},
      ${isDexMessage && txEvent.attributes.action === 'Withdraw' && dexPairId},
      ${lastMsgID || null}
    )`);
  return lastID;
}
