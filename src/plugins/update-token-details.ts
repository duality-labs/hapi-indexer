import { Asset, AssetList, Chain } from '@chain-registry/types';
import { Policy, PolicyOptions } from '@hapi/catbox';
import { Plugin, ServerRegisterOptions } from '@hapi/hapi';
import { assets, chains } from 'chain-registry';

import { inMs, seconds } from '../storage/sqlite3/db/timeseriesUtils';
import { getAssetInfo } from '../storage/sqlite3/ingest/utils/assets';

const { CHAIN_NAME='', NODE_ENV = '', ASSET_MAP='' } = process.env;

export interface PluginContext {
  getTokenDetails: (token: string) => Promise<Asset | null>;
}
export interface CachedTokenDetailsPluginContext {
  cachedTokenDetails?: PluginContext;
}


type TokenDetailsCache = Policy<Asset, PolicyOptions<Asset>>;
const ibcDenomRegex = /^ibc\/[0-9A-Fa-f]+$/;

interface DexTokensDetails {
  chain_name: string,
  base_denom: string,
  port_id?: string,
  channel_id?: string,
  coingecko_id?: string,
}
interface DexTokenTableRow extends Partial<DexTokensDetails> {
  token: string,
}

export const name = 'getTokenDetails';
export const plugin: Plugin<ServerRegisterOptions> = {
  name,
  register: async function (server) {
    // create cache
    const cache: TokenDetailsCache = server.cache({
      segment: 'token-details',
      generateFunc: async (id): DexTokensDetails | null => {
        const token = `${id}`;

        const registeredAsset = getRegisteredAsset(token);
        if (registeredAsset) {
          
        }
        const asset = getDevAsset(token)
          || getRegisteredAsset(token)
          || getUnregisteredAsset(token)
        // if in a dev environment allow reading faked details from a map
        if (NODE_ENV === 'development' && ASSET_MAP) {
          try {
            const tokenDetails = JSON.parse(ASSET_MAP) as {
              [token: string]: DexTokensDetails
            };
            if (tokenDetails[token]) {
              return tokenDetails[token];
            }
          }
          catch (e) {
            throw new Error(`Could not parse ASSET_MAP: ${(e as Error)?.message}`)
          }
        }
        
        const asset = await getAssetInfo(token);

        function getIBCInfo(token: string): DexTokensDetails | null {

          // try to lookup IBC denom details from chain-registry info
          if (CHAIN_NAME) {
            // attempt to lookup details from Chain Registry directory
          }

          // if not in directory try querying the chain
          if (ibcDenomRegex.test(token)) {
            return null
          }
          return null
        }
      },
      generateTimeout: 30 * seconds * inMs,
    });
    // add cache method into response context
    const pluginContext: PluginContext = {
      getTokenDetails: async (token: string) => {
        return await cache.get(token);
      },
    };
    // add plugin context methods to plugin under server.plugin[pluginName][key]
    server.expose(pluginContext);
  },
};
