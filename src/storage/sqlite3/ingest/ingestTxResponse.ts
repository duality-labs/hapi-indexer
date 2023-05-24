import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';

import insertDexTokensRows from './tables/dex.tokens';
import insertDexPairsRows from './tables/dex.pairs';
import insertBlockRows from './tables/block';
import insertTxRows from './tables/tx';
import insertTxEventRows from './tables/tx_result.events';

import insertEventTickUpdate from './tables/event.TickUpdate';
import insertEventSwap from './tables/event.Swap';
import insertEventDeposit from './tables/event.Deposit';
import insertEventWithdraw from './tables/event.Withdraw';
import { upsertDerivedTickStateRows } from './tables/derived.tick_state';

import decodeEvent from './utils/decodeEvent';
import { getDexMessageAction, isValidResult } from './utils/utils';

export default async function ingestTxs(txPage: TxResponse[]) {
  for (const [index, tx_result] of txPage.entries()) {
    // skip invalid transactions
    if (!isValidResult(tx_result)) {
      return;
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
    await insertTxRows(tx_result, index);

    // then add transaction event rows
    for (const txEvent of txEvents) {

      if (!event.actions.includes(txEvent.attributes['action'])) {
        console.log('event actions', txEvent.attributes['action']);
        event.actions.push(txEvent.attributes['action']);

        if (txEvent.attributes['action'] === 'TickUpdate') {
          console.log('event', txEvent)
        }
      }

      await insertTxEventRows(tx_result, txEvent, index);

      // continue logic for dex events
      // if the event was a dex action then use that event to update tables
      const dexAction = getDexMessageAction(txEvent);
      if (dexAction) {
        // add event rows to specific event tables:
        switch (dexAction) {
          case 'Deposit':
            await insertEventDeposit(tx_result, txEvent, index);
            break;
          case 'Withdraw':
            await insertEventWithdraw(tx_result, txEvent, index);
            break;
          case 'Swap':
            await insertEventSwap(tx_result, txEvent, index);
            break;
          case 'TickUpdate':
            await insertEventTickUpdate(tx_result, txEvent, index);
            await upsertDerivedTickStateRows(tx_result, txEvent, index);
            break;
        }
      }
    }
  }
}

const event = {
  actions: [] as string[]
};
