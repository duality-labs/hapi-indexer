import { ChainRegistryClient } from '@chain-registry/client';

const { REST_API = '', CHAIN_REGISTRY_CHAIN_NAME = '' } = process.env;

export async function getAssetInfo(chainDenom: string) {
  const chainName = ibcDenomRegex.test(chainDenom)
    ? await getIbcChainName(chainDenom)
    : CHAIN_REGISTRY_CHAIN_NAME;

  if (chainName) {
    // create an instance of ChainRegistryClient by passing in the chain names
    const client = new ChainRegistryClient({
      chainNames: [chainName],
    });

    // get the current data for the expected chain
    await client.fetchUrls();

    // get asset list
    const assetList = client.getChainAssetList(chainName);
    // search the found chain for the base assets
    const chainAsset = assetList.assets.find((asset) => {
      return asset.base === chainDenom;
    });
    if (chainAsset) {
      return chainAsset;
    }
    // get asset list (including ibc assets)
    const generatedAssetList = client.getGeneratedAssetLists(chainName);
    const ibcAsset = generatedAssetList
      .flatMap((list) => list.assets)
      .find((asset) => {
        return asset.base === chainDenom;
      });
    if (ibcAsset) {
      return ibcAsset;
    }
  }
}

const ibcDenomRegex = /^ibc\/([0-9A-Fa-f]+)$/;
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
    client_id: 'string';
    client_state: {
      chain_id: 'string';
    };
  };
  proof: 'string';
  proof_height: {
    revision_number: 'string';
    revision_height: 'string';
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

async function getIbcChainName(chainDenom: string) {
  const ibcTrace = await getIbcTraceInfo(chainDenom);
  if (ibcTrace) {
    // search chain for IBC asset data
    // "path" is just the combination of "port" and "channel"
    const [port, channel] = ibcTrace.path.split('/');
    const clientState = await getIbcClientState(channel, port);
    const chainId = clientState?.client_state?.chain_id;

    // remove trailing number version indications from any chain ID to get chain name
    return chainId?.replace(/-\d+$/, '');
  }
}
