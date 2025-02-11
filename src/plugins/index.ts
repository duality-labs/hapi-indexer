import * as ResponseCompressionPlugin from './response-compression';

export type GlobalPlugins = ResponseCompressionPlugin.PluginContext;

export default [ResponseCompressionPlugin.plugin];
