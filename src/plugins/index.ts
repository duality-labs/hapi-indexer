import * as CachedTokenPricesPlugin from './cached-token-prices';
import * as ResponseCompressionPlugin from './response-compression';

export interface GlobalPlugins
  extends ResponseCompressionPlugin.PluginContext,
    CachedTokenPricesPlugin.PluginContext {}

export default [
  ResponseCompressionPlugin.plugin,
  CachedTokenPricesPlugin.plugin,
];
