import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';
import { DecodedTxEvent } from './decodeEvent';

export function isValidResult(tx_result: TxResponse): boolean {
  return tx_result.code === 0;
}

export function isDexMessage(txEvent: DecodedTxEvent): boolean {
  return (
    txEvent.attributes.module === 'dex' &&
    (txEvent.type === 'message' || txEvent.type === 'TickUpdate') &&
    !!txEvent.attributes.action
  );
}

type DexMessageAction =
  | 'PlaceLimitOrder'
  | 'Deposit'
  | 'Withdraw'
  | 'TickUpdate';

export function getDexMessageAction(
  txEvent: DecodedTxEvent
): DexMessageAction | undefined {
  if (isDexMessage(txEvent)) {
    return txEvent.attributes.action as DexMessageAction;
  }
}
