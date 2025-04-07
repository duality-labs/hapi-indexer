import { GetData } from './utils/response';

interface BaseRequestPayload {
  params?: Record<string, string>;
  query?: Record<string, string>;
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
