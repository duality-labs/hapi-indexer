import { Event as TxEvent } from 'cosmjs-types/tendermint/abci/types';

// transform given events
//   eg. { attributes: [{ key: "dHlwZQ==", value: "bWVzc2FnZQ==", index: true }] }
// into events with attributes that have been decoded and mapped into an easy to use object
//   eg. { attributes: { type: "message" } }
interface DecodedAttributeMap {
  [key: string]: string;
}
export interface DecodedTxEvent extends Omit<TxEvent, 'attributes'> {
  index: number;
  attributes: DecodedAttributeMap;
}

export default function decodeEvent(
  { type, attributes }: TxEvent,
  index: number
): DecodedTxEvent {
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
    ),
  };
}
