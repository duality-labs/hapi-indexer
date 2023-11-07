import { assets, chains, ibc } from 'chain-registry';
import { ChainRegistryClient } from '@chain-registry/client';
import { Asset, AssetList } from '@chain-registry/types';

const { CHAIN_REGISTRY_CHAIN_NAME = '' } = process.env;

function getAssetLists(): AssetList[] {
  const chainName = CHAIN_REGISTRY_CHAIN_NAME;
  if (chainName) {
    // create an instance of ChainRegistryClient with static data
    const client = new ChainRegistryClient({
      chainNames: [chainName],
      chains: chains,
      ibcData: ibc,
      assetLists: assets,
    });

    // get asset lists
    return [
      // get asset lists of IBC connected chains
      // place generated assets first because they hold more detail:
      // some IBC denoms assets may be placed on the main chain asset list
      // because they can be used as fee denoms: and may have sparse info
      ...client.getGeneratedAssetLists(chainName),
      // get asset list of chain
      client.getChainAssetList(chainName),
    ].filter(Boolean);
  } else {
    throw new Error('main CHAIN_NAME is not defined');
  }
}

export function getAsset(
  chainDenom: string,
  // default to static Chain Registry asset lists
  assetLists: AssetList[] = getAssetLists()
): Asset | undefined {
  return assetLists
    .flatMap((assetList) => assetList)
    .flatMap((assetList) => assetList.assets)
    .find((asset) => {
      return asset.base === chainDenom;
    });
}
