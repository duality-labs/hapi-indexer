import { GetData } from './utils/response';

interface BaseRequestPayload {
  Params?: Record<string, string>;
  Query?: Record<string, string>;
}
type BaseResponsePayload = object;

export type Route<
  RequestPayload extends BaseRequestPayload,
  ResponsePayload extends BaseResponsePayload
> = {
  method: 'get' | 'post';
  path: string;
  handler: GetData<RequestPayload, ResponsePayload>;
};
