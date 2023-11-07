import { chains } from 'chain-registry';
import { ChainRegistryClient } from '@chain-registry/client';
import { Asset, AssetList } from '@chain-registry/types';
import { Policy, PolicyOptions } from '@hapi/catbox';
import { Plugin, ServerRegisterOptions } from '@hapi/hapi';

import { hours, inMs, seconds } from '../storage/sqlite3/db/timeseriesUtils';
import defaultLogger from '../logger';

const { REST_API = '', CHAIN_REGISTRY_CHAIN_NAME = '' } = process.env;

type AssetListsCache = Policy<AssetList[], PolicyOptions<AssetList[]>>;
type ChainQueryCache = Policy<Asset, PolicyOptions<Asset>>;

const name = 'cachedAssets' as const;
export interface PluginContext {
  [name]: {
    getAsset: (chainDenom: string) => Promise<Asset | undefined>;
    getAssetLists: (chainName: string) => Promise<AssetList[]>;
  };
}
const ibcDenomRegex = /^ibc\/([0-9A-Fa-f]+)$/;

export const plugin: Plugin<ServerRegisterOptions> = {
  name,
  register: async function (server) {
    // create cache for assets
    const assetListsCache: AssetListsCache = server.cache({
      segment: 'chain-assets-registered',
      // allow data to be replaced infrequently, and return stale data quick
      staleIn: 24 * hours * inMs,
      staleTimeout: 1 * seconds * inMs,
      // don't expire data, old data is better than no data here
      expiresIn: Number.MAX_SAFE_INTEGER,
      // generate a main chain AssetList and IBC chain AssetList if passed as ID
      generateFunc: async (id): Promise<AssetList[]> => {
        const ibcChainName = `${id}`;
        const chainName = CHAIN_REGISTRY_CHAIN_NAME;
        if (chainName) {
          // create an instance of ChainRegistryClient by passing in the chain names
          const client = new ChainRegistryClient({
            chainNames: ibcChainName ? [chainName, ibcChainName] : [chainName],
          });

          // get the current data for the expected chain
          await client.fetchUrls();

          // get asset lists
          const assetList = client.getChainAssetList(chainName);
          return (
            !ibcChainName
              ? [assetList]
              : // place generated assets first because they hold more detail:
                // some IBC denoms assets may be placed on the chain asset list
                // because they are used as fee denoms: and may have sparse info
                [...client.getGeneratedAssetLists(chainName), assetList]
          ).filter(Boolean);
        } else {
          throw new Error('main CHAIN_NAME is not defined');
        }
      },
      generateTimeout: 60 * seconds * inMs,
    });

    // create cache for assets
    const chainQueryCache: ChainQueryCache = server.cache({
      segment: 'chain-asset-queries',
      // allow data to be replaced infrequently, and return stale data quick
      staleIn: 24 * hours * inMs,
      staleTimeout: 1 * seconds * inMs,
      // don't expire data, old data is better than no data here
      expiresIn: Number.MAX_SAFE_INTEGER,
      // generate a main chain AssetList and IBC chain AssetList if passed as ID
      generateFunc: async (id): Promise<Asset> => {
        const chainDenom = `${id}`;
        const ibcHash = chainDenom.match(ibcDenomRegex)?.[1];
        const ibcTrace = ibcHash && (await getIbcTraceInfo(chainDenom));
        if (!ibcHash || !ibcTrace) {
          throw new Error(
            `no IBC trace denom information was found for: ${id}`,
            {
              cause: 404,
            }
          );
        }

        // search chain for IBC asset data
        // "path" is just the combination of "port" and "channel"
        const [port, channel] = ibcTrace.path.split('/');
        const clientState = await getIbcClientState(channel, port);
        const chainId = clientState?.client_state?.chain_id;

        // note: the chains dependency from chain-registry here means we cannot
        //       identify chains newer than the version saved in chain-registry
        const chain = chains.find((chain) => chain.chain_id === chainId);

        // look up chain ID in Chain Registry
        if (!chain) {
          throw new Error(`no registered Chain was found for IBC denom ${id}`, {
            cause: 404,
          });
        }

        const chainName = chain.chain_name;
        const assetsLists = await assetListsCache.get(chainName);
        if (!assetsLists) {
          throw new Error(
            `no asset lists were found for denom ${id} and chain ${chainName}`,
            { cause: 404 }
          );
        }

        const asset = assetsLists
          .flatMap((assetList) => assetList)
          .flatMap((assetList) => assetList.assets)
          .find((asset) => {
            return (
              asset.base === ibcTrace.base_denom &&
              asset.ibc?.dst_channel === channel &&
              asset.traces?.find((trace) => {
                // note: this check might be too specific for non-Cosmos chains
                return (
                  trace.type === 'ibc' &&
                  trace.chain.port === port &&
                  trace.chain.channel_id === channel &&
                  trace.counterparty.chain_name === chainName &&
                  trace.counterparty.base_denom === ibcTrace.base_denom
                );
              })
            );
          });

        if (!asset) {
          throw new Error(
            `no asset lists were found for denom ${id} and chain ${chainName}`,
            { cause: 404 }
          );
        }

        return asset;
      },
      generateTimeout: 60 * seconds * inMs,
    });

    // add cache method into response context
    const pluginContext: PluginContext['cachedAssets'] = {
      getAsset: async (chainDenom: string) => {
        if (ibcDenomRegex.test(chainDenom)) {
          // lookup IBC denom information
          try {
            const asset = await chainQueryCache.get(chainDenom);
            if (!asset) {
              throw new Error(
                `Cannot find query cache value for: ${chainDenom}`,
                { cause: 404 }
              );
            }
            return asset;
          } catch (e) {
            defaultLogger.error(
              `Get cachedAssets error for lookup ${chainDenom}: ${
                (e as Error)?.message
              }`
            );
          }
        }
      },
      getAssetLists: async (chainName: string) => {
        const assetLists = await assetListsCache.get(chainName);
        if (!assetLists) {
          throw new Error(`Cannot find asset lists for: ${chainName}`, {
            cause: 404,
          });
        }
        return assetLists;
      },
    };

    // add plugin context methods to plugin under server.plugin[pluginName][key]
    server.expose(pluginContext);
  },
};

interface DenomTrace {
  path: string;
  base_denom: string;
}
interface QueryDenomTraceResponse {
  denom_trace: DenomTrace;
}

async function getIbcTraceInfo(chainDenom: string) {
  const ibcHash = chainDenom.match(ibcDenomRegex)?.[1];
  if (REST_API && ibcHash) {
    const url = `${REST_API}/ibc/applications/transfer/v1beta1/denom_traces/${ibcHash}`;
    try {
      // query chain for IBC denom information
      const response = await fetch(url);
      const data = (await response.json()) as QueryDenomTraceResponse;
      return data?.denom_trace;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`Unable to get IBC asset info for ${url}`, e);
    }
  }
}

interface QueryClientStateResponse {
  identified_client_state: {
    client_id: string;
    client_state: {
      chain_id: string;
    };
  };
  proof: string;
  proof_height: {
    revision_number: string;
    revision_height: string;
  };
}

async function getIbcClientState(channelId: string, portId: string) {
  const url = `${REST_API}/ibc/core/channel/v1beta1/channels/${channelId}/ports/${portId}/client_state`;
  try {
    // query chain for IBC information
    const response = await fetch(url);
    const data = (await response.json()) as QueryClientStateResponse;
    return data?.identified_client_state;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`Unable to get IBC asset info for ${url}`, e);
  }
}
