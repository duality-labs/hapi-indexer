import { config as mainnet } from './mainnet';
import { config as testnet } from './testnet';

const { NETWORK_TYPE = '' } = process.env;

// default to mainnet
export const config = NETWORK_TYPE === 'testnet' ? testnet : mainnet;
