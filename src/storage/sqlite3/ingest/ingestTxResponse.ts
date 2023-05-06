import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';

import insertDexTokensRows from './tables/dex.tokens';
import insertDexPairsRows from './tables/dex.pairs';
import insertBlockRows from './tables/block';
import insertTxRows from './tables/tx';
import insertTxEventRows from './tables/tx_result.events';

import decodeEvent, { DecodedTxEvent } from './utils/decodeEvent';

export default async function ingestTxs(txPage: TxResponse[]) {
  return await promiseMapInSeries(
    txPage,
    async (tx_result: TxResponse, index: number) => {
      const txEvents = (tx_result.events || []).map(decodeEvent);
      // first add block rows
      await insertBlockRows(tx_result);
      // then add token foreign keys
      await promiseMapInSeries(txEvents, insertDexTokensRows);
      // then add token foreign keys
      await promiseMapInSeries(txEvents, insertDexPairsRows);
      // then add transaction rows
      await insertTxRows(tx_result, index);
      // then add transaction event rows
      await promiseMapInSeries(txEvents, async (txEvent: DecodedTxEvent) => {
        await insertTxEventRows(tx_result, txEvent, index);
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
