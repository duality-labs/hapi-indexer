import { TxResponse } from '../../../@types/tx';

import insertDexTokensRows from './tables/dex.tokens';
import insertDexPairsRows from './tables/dex.pairs';
import insertBlockRows from './tables/block';
import insertTxRows from './tables/tx';
import insertTxMsgRows from './tables/tx_msg';
import insertTxEventRows from './tables/tx_result.events';

import insertEventTickUpdate from './tables/event.TickUpdate';
import insertEventPlaceLimitOrder from './tables/event.PlaceLimitOrder';
import insertEventDeposit from './tables/event.DepositLP';
import insertEventWithdraw from './tables/event.WithdrawLP';
import { upsertDerivedTickStateRows } from './tables/derived.tick_state';

import decodeEvent, { DecodedTxEvent } from './utils/decodeEvent';
import { getDexMessageAction, isValidResult } from './utils/utils';
import Timer from '../../../utils/timer';

let lastHeight = '0';
let lastTxIndex = 0;
export default async function ingestTxs(
  txPage: (TxResponse & { decodedEvents?: DecodedTxEvent[] })[],
  timer = new Timer()
) {
  for (const tx_result of txPage) {
    // find this transaction's index
    lastTxIndex = tx_result.height === lastHeight ? lastTxIndex + 1 : 0;
    lastHeight = tx_result.height;
    const index = lastTxIndex;

    // skip invalid transactions
    if (!isValidResult(tx_result)) {
      continue;
    }

    // get tx events in decoded form
    const txEvents = (tx_result.events || []).map(decodeEvent);
    // append decoded events into result so other functions to do need to
    tx_result.decodedEvents = txEvents;

    // first add block rows
    timer.start('processing:txs:block');
    await insertBlockRows(tx_result);
    timer.stop('processing:txs:block');

    // then add token foreign keys
    for (const txEvent of txEvents) {
      timer.start('processing:txs:dex.tokens');
      await insertDexTokensRows(txEvent);
      timer.stop('processing:txs:dex.tokens');
    }

    // then add pair foreign keys
    for (const txEvent of txEvents) {
      timer.start('processing:txs:dex.pairs');
      await insertDexPairsRows(txEvent);
      timer.stop('processing:txs:dex.pairs');
    }

    // then add transaction rows
    timer.start('processing:txs:tx');
    await insertTxRows(tx_result, index);
    timer.stop('processing:txs:tx');

    // then add transaction event rows
    let lastMsgID: number | undefined = undefined;
    for (const txEvent of txEvents) {
      // get new or last know related Msg id
      timer.start('processing:txs:tx_msg');
      const newMsg = await insertTxMsgRows(txEvent);
      timer.stop('processing:txs:tx_msg');
      lastMsgID = newMsg ? newMsg.lastID : lastMsgID;

      // add transaction event
      timer.start('processing:txs:tx_result.events');
      await insertTxEventRows(tx_result, txEvent, index, lastMsgID);
      timer.stop('processing:txs:tx_result.events');

      // continue logic for dex events
      // if the event was a dex action then use that event to update tables
      const dexAction = getDexMessageAction(txEvent);
      if (dexAction) {
        // add event rows to specific event tables:
        switch (dexAction) {
          case 'DepositLP':
            timer.start('processing:txs:event.DepositLP');
            await insertEventDeposit(tx_result, txEvent, index);
            timer.stop('processing:txs:event.DepositLP');
            break;
          case 'WithdrawLP':
            timer.start('processing:txs:event.WithdrawLP');
            await insertEventWithdraw(tx_result, txEvent, index);
            timer.stop('processing:txs:event.WithdrawLP');
            break;
          case 'PlaceLimitOrder':
            timer.start('processing:txs:event.PlaceLimitOrder');
            await insertEventPlaceLimitOrder(tx_result, txEvent, index);
            timer.stop('processing:txs:event.PlaceLimitOrder');
            break;
          case 'TickUpdate':
            await insertEventTickUpdate(tx_result, txEvent, index, timer);
            await upsertDerivedTickStateRows(tx_result, txEvent, index, timer);
            break;
        }
      }
    }
  }
}
