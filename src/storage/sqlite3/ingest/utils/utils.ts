import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';
import { DecodedTxEvent } from './eventTypes';
import { DepositEventAttributeMap } from '../tables/event.Deposit';
import { SwapEventAttributeMap } from '../tables/event.Swap';
import { WithdrawEventAttributeMap } from '../tables/event.Withdraw';
import { TickUpdateEventAttributeMap } from '../tables/event.TickUpdate';

// type DexEventAttributeMap = SwapEventAttributeMap | DepositEventAttributeMap | WithdrawEventAttributeMap | TickUpdateEventAttributeMap;
// type DexEvent = DecodedTxEvent<DexEventAttributeMap>

type DexEvent = |
  DecodedTxEvent<SwapEventAttributeMap> |
  DecodedTxEvent<DepositEventAttributeMap> |
  DecodedTxEvent<WithdrawEventAttributeMap> |
  DecodedTxEvent<TickUpdateEventAttributeMap>

export function isValidResult(tx_result: TxResponse): boolean {
  return tx_result.code === 0;
}

export function isDexMessage(txEvent: DexEvent): boolean {
  return (
    txEvent.attributes.module === 'dex' &&
    (txEvent.type === 'message' || txEvent.type === 'TickUpdate') &&
    !!txEvent.attributes.action
  );
}

type DexMessageAction = 'Swap' | 'Deposit' | 'Withdraw' | 'TickUpdate';

type DecodedAttributeMap = Record<string, string>

export function getDexMessageAction(
  txEvent: DecodedTxEvent<DecodedAttributeMap>
): DexMessageAction | undefined {
  if (isDexMessage(txEvent as unknown as DexEvent)) {
    return txEvent.attributes.action as DexMessageAction;
  }
}

export function getDexEvent(
  txEvent: DecodedTxEvent<DecodedAttributeMap>
) {
  // convert type if it passes all our checks
  if (isDexMessage(txEvent as unknown as DexEvent)) {
    const dexEvent = txEvent as unknown as DexEvent;
    switch (dexEvent.attributes.action) {
      case 'Deposit': return dexEvent as DecodedTxEvent<DepositEventAttributeMap>
      case 'Withdraw': return dexEvent as DecodedTxEvent<WithdrawEventAttributeMap>
      case 'Swap': return dexEvent as DecodedTxEvent<SwapEventAttributeMap>
      case 'TickUpdate': return dexEvent as DecodedTxEvent<TickUpdateEventAttributeMap>
    }
  }
}
