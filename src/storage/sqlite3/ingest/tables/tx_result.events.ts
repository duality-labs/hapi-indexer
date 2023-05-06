import sql from 'sql-template-strings';
import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';
import { Event as TxEvent } from 'cosmjs-types/tendermint/abci/types';

import db from '../../db/db';

import { getBlockTimeFromTxResult } from './block';
import insertDexPairsRows from './dex.pairs';
import insertEventTickUpdate from './event.TickUpdate';
import insertEventSwap from './event.Swap';
import insertEventDeposit from './event.Deposit';
import insertEventWithdraw from './event.Withdraw';
import { upsertDerivedTickStateRows } from './derived.tick_state';

// transform given events
//   eg. { attributes: [{ key: "dHlwZQ==", value: "bWVzc2FnZQ==", index: true }] }
// into events with attributes that have been decoded and mapped into an easy to use object
//   eg. { attributes: { type: "message" } }
interface DecodedAttributeMap {
  [key: string]: string;
}
export interface DecodedTxEvent extends Omit<TxEvent, 'attributes'> {
  index: number;
  attributes: DecodedAttributeMap;
}

export function decodeEvent(
  { type, attributes }: TxEvent,
  index: number
): DecodedTxEvent {
  return {
    index,
    type,
    attributes: attributes.reduce<DecodedAttributeMap>(
      (acc, { key, value }) => {
        if (key) {
          const decodedKey = Buffer.from(`${key}`, 'base64').toString('utf8');
          const decodedValue = value
            ? Buffer.from(`${value}`, 'base64').toString('utf8')
            : null;
          if (decodedKey) {
            acc[decodedKey] = decodedValue || '';
          }
        }
        return acc;
      },
      {}
    ),
  };
}

export default async function insertTxEventRows(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number
) {
  const isDexMessage =
    tx_result.code === 0 &&
    txEvent.attributes.module === 'dex' &&
    (txEvent.type === 'message' || txEvent.type === 'TickUpdate');
  const dexPairId =
    isDexMessage && txEvent.attributes.Token0 && txEvent.attributes.Token1
      ? await insertDexPairsRows(txEvent)
      : undefined;

  const blockTime = getBlockTimeFromTxResult(tx_result);
  const { lastID } = await db.run(sql`
    INSERT INTO 'tx_result.events' (
      'block.header.height',
      'block.header.time_unix',
      'tx.index',
      'tx.tx_result.code',
      'index',
      'type',
      'attributes',
      'meta.dex.pair_swap',
      'meta.dex.pair_deposit',
      'meta.dex.pair_withdraw'
    ) values (
      ${tx_result.height},
      ${blockTime},
      ${index},
      ${tx_result.code},

      ${txEvent.index},
      ${txEvent.type},
      ${JSON.stringify(txEvent.attributes)},

      ${isDexMessage && txEvent.attributes.action === 'Swap' && dexPairId},
      ${isDexMessage && txEvent.attributes.action === 'Deposit' && dexPairId},
      ${isDexMessage && txEvent.attributes.action === 'Withdraw' && dexPairId}
    )`);
  // continue logic for several dex events
  // add event row to specific event table:
  if (isDexMessage && txEvent.attributes.action === 'TickUpdate') {
    await insertEventTickUpdate(tx_result, txEvent, index);
    // add derivations of TickUpdates before resolving
    await upsertDerivedTickStateRows(tx_result, txEvent, index);
  } else if (isDexMessage && txEvent.attributes.action === 'Swap') {
    await insertEventSwap(tx_result, txEvent, index);
  } else if (isDexMessage && txEvent.attributes.action === 'Deposit') {
    await insertEventDeposit(tx_result, txEvent, index);
  } else if (isDexMessage && txEvent.attributes.action === 'Withdraw') {
    await insertEventWithdraw(tx_result, txEvent, index);
  }
  return lastID;
}
