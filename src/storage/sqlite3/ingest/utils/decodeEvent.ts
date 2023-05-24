import { Event as TxEvent } from 'cosmjs-types/tendermint/abci/types';
import { BaseDexEventAttributeMap, DecodedTxEvent } from './eventTypes';
import { DepositEventAttributeMap } from '../tables/event.Deposit';
import { SwapEventAttributeMap } from '../tables/event.Swap';
import { WithdrawEventAttributeMap } from '../tables/event.Withdraw';
import { TickUpdateEventAttributeMap } from '../tables/event.TickUpdate';

type DexEvent = SwapEventAttributeMap | DepositEventAttributeMap | WithdrawEventAttributeMap | TickUpdateEventAttributeMap;

// interface DecodedAttributeMap {
//   [key: string]: string;
// }
type DecodedAttributeMap = Record<string, string>

export default function decodeEvent<T = DecodedAttributeMap>(
  { type, attributes }: TxEvent,
  index: number
): DecodedTxEvent<T> {
  return {
    index,
    type,
    attributes: attributes.reduce<DecodedAttributeMap>(
      (acc, { key, value }) => {
        if (key) {
          const decodedKey = Buffer.from(`${key}`, 'base64').toString('utf8');
          const decodedValue = value
            ? Buffer.from(`${value}`, 'base64').toString('utf8')
            : null;
          if (decodedKey) {
            acc[decodedKey] = decodedValue || '';
          }
        }
        return acc;
      },
      {}
    ) as T,
  };
}
