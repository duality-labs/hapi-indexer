import { ExtendedResponseJSON } from './utils/cache-query';
import { GetData } from './utils/response';

interface BaseRequestPayload {
  params?: Record<string, string>;
  query?: Record<string, string>;
}
type BaseResponsePayload = object;

export type Route<
  RequestPayload extends BaseRequestPayload,
  ResponsePayload extends BaseResponsePayload,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AdditionalStreams extends Record<string, GetData<any, any>> = Record<
    string,
    never
  >
> = {
  method: 'get' | 'post';
  path: string;
  handler: GetData<RequestPayload, ResponsePayload>;
  updateState?: (
    state: ResponsePayload[],
    dataUpdates: ResponsePayload[]
  ) => ResponsePayload[];
  handleAdditionalStreams?: (
    request: RequestPayload,
    state: ExtendedResponseJSON<ResponsePayload>
  ) => AdditionalStreams;
};
