import { TxResponse } from '../../../@types/tx';

import insertDexTokensRows from './tables/dex.tokens';
import insertDexPairsRows from './tables/dex.pairs';
import insertBlockRows from './tables/block';
import insertTxRows from './tables/tx';
import insertTxMsgRows from './tables/tx_msg';
import insertTxEventRows from './tables/tx_result.events';

import insertEventTickUpdate from './tables/event.TickUpdate';
import insertEventPlaceLimitOrder from './tables/event.PlaceLimitOrder';
import insertEventDeposit from './tables/event.Deposit';
import insertEventWithdraw from './tables/event.Withdraw';
import { upsertDerivedTickStateRows } from './tables/derived.tick_state';

import decodeEvent from './utils/decodeEvent';
import { getDexMessageAction, isValidResult } from './utils/utils';

export default async function ingestTxs(txPage: TxResponse[]) {
  for (const tx_result of txPage) {
    // skip invalid transactions
    if (!isValidResult(tx_result)) {
      continue;
    }

    // get tx events in decoded form
    const txEvents = (tx_result.events || []).map(decodeEvent);

    // first add block rows
    await insertBlockRows(tx_result);

    // then add token foreign keys
    for (const txEvent of txEvents) {
      await insertDexTokensRows(txEvent);
    }

    // then add pair foreign keys
    for (const txEvent of txEvents) {
      await insertDexPairsRows(txEvent);
    }

    // then add transaction rows
    await insertTxRows(tx_result);

    // then add transaction event rows
    let lastMsgID: number | undefined = undefined;
    for (const txEvent of txEvents) {
      // get new or last know related Msg id
      const newMsg = await insertTxMsgRows(txEvent);
      lastMsgID = newMsg ? newMsg.lastID : lastMsgID;

      // add transaction event
      await insertTxEventRows(tx_result, txEvent, lastMsgID);

      // continue logic for dex events
      // if the event was a dex action then use that event to update tables
      const dexAction = getDexMessageAction(txEvent);
      if (dexAction) {
        // add event rows to specific event tables:
        switch (dexAction) {
          case 'Deposit':
            await insertEventDeposit(tx_result, txEvent);
            break;
          case 'Withdraw':
            await insertEventWithdraw(tx_result, txEvent);
            break;
          case 'PlaceLimitOrder':
            await insertEventPlaceLimitOrder(tx_result, txEvent);
            break;
          case 'TickUpdate':
            await insertEventTickUpdate(tx_result, txEvent);
            await upsertDerivedTickStateRows(tx_result, txEvent);
            break;
        }
      }
    }
  }
}
