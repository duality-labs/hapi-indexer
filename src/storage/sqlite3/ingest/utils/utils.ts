import { TxResponse } from '../../../../@types/tx';
import decodeEvent, { DecodedTxEvent } from './decodeEvent';

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

export function isDexTickUpdate(txEvent: DecodedTxEvent): boolean {
  return (
    isDexMessage(txEvent) &&
    txEvent.type === 'TickUpdate' &&
    txEvent.attributes.action === 'TickUpdate'
  );
}

export function isDexTrancheUpdate(txEvent: DecodedTxEvent): boolean {
  return (
    isDexTickUpdate(txEvent) && txEvent.attributes['TrancheKey'] !== undefined
  );
}

export function isDexSwapTickUpdate(
  txEvent: DecodedTxEvent,
  txResponse: TxResponse & { decodedEvents?: DecodedTxEvent[] }
): boolean {
  // get the related txEvents of from the same tx as the txEvent
  const txEvents =
    txResponse.decodedEvents ||
    txResponse.events
      .filter((txEvent) => txEvent.type === 'message')
      .map(decodeEvent);

  // get the related tx dex action
  const placeLimitOrderEvent: DecodedTxEvent | undefined = txEvents.find(
    (txDecodedEvent) =>
      txDecodedEvent.attributes['action'] === 'PlaceLimitOrder' &&
      txDecodedEvent.attributes['module'] === 'dex'
  );

  // swap events are TickUpdates of PlaceLimitOrder actions that either:
  return (
    !!placeLimitOrderEvent &&
    // did not deposit reserves, ie. no shares were created
    (!Number(placeLimitOrderEvent.attributes['Shares']) ||
      // or the deposited reserves were not the tranche of the TickUpdate
      placeLimitOrderEvent.attributes['TrancheKey'] !==
        txEvent.attributes['TrancheKey'])
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
