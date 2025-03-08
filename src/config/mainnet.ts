import { ConfigType } from './types';

export const config: ConfigType = {
  networkType: 'mainnet',
  // define known USDC denoms for easy approximate USD value responses
  denomsUSDC: [
    // Noble USDC
    'ibc/B559A80D62249C8AA07A380E2A2BEA6E5CA9A6F079C912C3A9E9B494105E4F81',
    // Axelar USDC
    'ibc/F082B65C88E4B6D5EF1DB243CDA1D331D002759E938A0F5CD3FFDC5D53B3E349',
  ],
};
