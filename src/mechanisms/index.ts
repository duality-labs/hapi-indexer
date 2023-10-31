import { Request, ResponseToolkit } from '@hapi/hapi';
import serverSentEventRequest from './server-sent-events';
import longPollRequest from './long-polling';
import { GetEndpointData, GetEndpointResponse } from './types';

export default function processRequest<
  PluginContext,
  DataSets extends unknown[],
  Shape
>({
  request,
  h,
  getData,
  getPaginatedResponse,
  getResponse,
  shape,
}: {
  request: Request;
  h: ResponseToolkit;
  getData: GetEndpointData<PluginContext, DataSets>;
  getPaginatedResponse: GetEndpointResponse<DataSets, Shape>;
  getResponse: GetEndpointResponse<DataSets, Shape>;
  shape: Shape;
}) {
  const canUseSSE =
    request.query['stream'] === 'true' &&
    request.raw.req.httpVersionMajor === 2;
  return canUseSSE
    ? serverSentEventRequest(request, h, shape, getData, getResponse)
    : longPollRequest(request, h, shape, getData, getPaginatedResponse);
}
