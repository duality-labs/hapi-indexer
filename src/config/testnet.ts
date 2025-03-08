import { ConfigType } from './types';

export const config: ConfigType = {
  networkType: 'mainnet',
  // define known USDC denoms for easy approximate USD value responses
  denomsUSDC: [
    // demo pair demoUSDC
    'factory/neutron19glux3jzdfyyz6ylmuksgxfj5phdaxfr2uhy86/factoryATOM',
    // Margined USDC
    'factory/neutron1nm80734yaw223ewvn30s32n2nfq6tdd0vzzdnk/ibc/usdc',
    // vault test USDC
    'factory/neutron1e2c5p8y5rw2hp4fjr05uvkrkz76ej0kqegnwxe/USDC',
  ],
};
