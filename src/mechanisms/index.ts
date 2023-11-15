import { Request, ResponseToolkit } from '@hapi/hapi';
import serverSentEventRequest from './server-sent-events';
import longPollRequest from './long-polling';
import { GetEndpointData, GetEndpointResponse } from './types';

export default function processRequest<
  PluginContext,
  DataSets extends unknown[],
  Shape
>(
  request: Request,
  h: ResponseToolkit,
  opts: {
    getData: GetEndpointData<PluginContext, DataSets>;
    getPaginatedResponse: GetEndpointResponse<DataSets, Shape>;
    shape: Shape;
  }
) {
  const canUseSSE =
    request.query['stream'] === 'true' &&
    request.raw.req.httpVersionMajor === 2;
  return canUseSSE
    ? serverSentEventRequest(request, h, opts)
    : longPollRequest(request, h, opts);
}
