import { Request, ResponseObject, ResponseToolkit } from '@hapi/hapi';
import serverSentEventRequest from './server-sent-events';
import longPollRequest from './long-polling';
import { GetEndpointData, GetEndpointResponse } from './types';

export function selectRequestMechanism<DataSets extends unknown[], Shape>(
  request: Request
): (
  request: Request,
  h: ResponseToolkit,
  getData: GetEndpointData<DataSets>,
  getResponse: GetEndpointResponse<DataSets, Shape>
) => Promise<ResponseObject | void> {
  const canUseSSE =
    request.query['stream'] === 'true' &&
    request.raw.req.httpVersionMajor === 2;
  return canUseSSE ? serverSentEventRequest : longPollRequest;
}
