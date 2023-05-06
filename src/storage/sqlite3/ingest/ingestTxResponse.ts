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

import decodeEvent, { DecodedTxEvent } from './utils/decodeEvent';
import { getDexMessageAction, isValidResult } from './utils/utils';

export default async function ingestTxs(txPage: TxResponse[]) {
  return await promiseMapInSeries(
    txPage,
    async (tx_result: TxResponse, index: number) => {
      // skip invalid transactions
      if (!isValidResult(tx_result)) {
        return;
      }

      const txEvents = (tx_result.events || []).map(decodeEvent);
      // first add block rows
      await insertBlockRows(tx_result);
      // then add token foreign keys
      await promiseMapInSeries(txEvents, insertDexTokensRows);
      // then add pair foreign keys
      await promiseMapInSeries(txEvents, insertDexPairsRows);
      // then add transaction rows
      await insertTxRows(tx_result, index);
      // then add transaction event rows
      await promiseMapInSeries(txEvents, async (txEvent: DecodedTxEvent) => {
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
      });
    }
  );
}

async function promiseMapInSeries<T>(
  list: Array<T>,
  itemCallback: (item: T, index: number, list: T[]) => Promise<unknown>
) {
  return list.reduce<Promise<unknown[]>>(async (listPromise, item, index) => {
    return Promise.all([
      ...(await listPromise),
      itemCallback(item, index, list),
    ]);
  }, new Promise((resolve) => resolve([])));
}
