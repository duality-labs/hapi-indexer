import { Request } from '@hapi/hapi';
import {
  PaginatedRequestQuery,
  PaginatedResponse,
} from '../storage/sqlite3/db/paginationUtils';
import {
  BlockRangeRequestQuery,
  BlockRangeResponse,
} from '../storage/sqlite3/db/blockRangeUtils';

type FlattenSingularItems<T> = T extends [infer U] ? U : T;

export interface EndpointResponse<DataSets extends unknown[], Shape>
  extends Partial<PaginatedResponse>,
    BlockRangeResponse {
  shape?: Shape;
  data: FlattenSingularItems<DataSets>;
}

export type GetEndpointData<DataSets extends unknown[]> = (
  server: Request['server'],
  params: Request['params'],
  query: PaginatedRequestQuery & BlockRangeRequestQuery
) => Promise<[height: number, ...DataSets] | null>;

export type GetEndpointResponse<DataSets extends unknown[], Shape> = (
  data: [height: number, ...DataSets],
  query: PaginatedRequestQuery & BlockRangeRequestQuery,
  options: GetEndpointResponseOptions
) => EndpointResponse<DataSets, Shape>;

export interface GetEndpointResponseOptions {
  paginate: boolean;
  shape: boolean;
}
