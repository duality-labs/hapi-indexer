import { ResponseDeliverTx } from 'cosmjs-types/tendermint/abci/types';

export interface TxResponse extends ResponseDeliverTx {
  height: string;
  timestamp: string;
  txhash: string;
}
