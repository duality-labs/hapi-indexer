import { Event as TxEvent } from 'cosmjs-types/tendermint/abci/types';

type DexMessageAction = 'Swap' | 'Deposit' | 'Withdraw' | 'TickUpdate';

export interface BaseDexEventAttributeMap<T extends DexMessageAction> {
  module: 'dex',
  action: T,
}

export interface DecodedTxEvent<T> extends Omit<TxEvent, 'attributes'> {
  index: number;
  attributes: T;
}
