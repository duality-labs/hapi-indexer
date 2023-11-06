import * as CachedChainAssetsPlugin from './cached-chain-assets';
import * as CachedTokenPricesPlugin from './cached-token-prices';
import * as ResponseCompressionPlugin from './response-compression';

export interface GlobalPlugins
  extends ResponseCompressionPlugin.PluginContext,
    CachedChainAssetsPlugin.PluginContext,
    CachedTokenPricesPlugin.PluginContext {}

export default [
  ResponseCompressionPlugin.plugin,
  CachedChainAssetsPlugin.plugin,
  CachedTokenPricesPlugin.plugin,
];
