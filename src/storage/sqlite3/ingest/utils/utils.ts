import { TxResponse } from '../../../../@types/tx';
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
  | 'DepositLP'
  | 'WithdrawLP'
  | 'TickUpdate';

export function getDexMessageAction(
  txEvent: DecodedTxEvent
): DexMessageAction | undefined {
  if (isDexMessage(txEvent)) {
    return txEvent.attributes.action as DexMessageAction;
  }
}
