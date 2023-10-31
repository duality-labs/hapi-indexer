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
    Partial<BlockRangeResponse> {
  shape?: Shape;
  data: FlattenSingularItems<DataSets>;
}

export type GetEndpointData<PluginContext, DataSets extends unknown[]> = (
  params: Request['params'],
  query: PaginatedRequestQuery & BlockRangeRequestQuery,
  context: PluginContext
) => Promise<[height: number, ...DataSets] | null>;

export type PaginateData<DataSets extends unknown[], Shape> = (
  data: [height: number, ...DataSets],
  query: PaginatedRequestQuery & BlockRangeRequestQuery
) => EndpointResponse<DataSets, Shape>;

export type GetEndpointResponse<DataSets extends unknown[], Shape> = (
  data: [height: number, ...DataSets],
  query: PaginatedRequestQuery & BlockRangeRequestQuery
) => EndpointResponse<DataSets, Shape>;

export interface GetEndpointResponseOptions<DataSets extends unknown[], Shape> {
  paginate: boolean;
  shape: boolean;
  defaults: Partial<EndpointResponse<DataSets, Shape>>;
}
