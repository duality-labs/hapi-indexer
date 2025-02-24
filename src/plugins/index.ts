import * as RequestCachePlugin from './cached-query';

export type GlobalPlugins = RequestCachePlugin.PluginContext;

export default [RequestCachePlugin.plugin];
