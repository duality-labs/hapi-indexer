import { Request, ResponseToolkit } from '@hapi/hapi';
import { mediaTypes } from '@hapi/accept';

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
    compressResponses?: boolean;
  }
) {
  const canUseSSE =
    request.raw.req.httpVersionMajor === 2 &&
    // respond to browser `new EventSource()` requests with SSE event streams
    (!!mediaTypes(request.headers['accept']).includes('text/event-stream') ||
      // and allow a forced stream in other cases (like manual and CI testing)
      request.query['stream'] === 'true');
  return canUseSSE
    ? serverSentEventRequest(request, h, opts)
    : longPollRequest(request, h, opts);
}
