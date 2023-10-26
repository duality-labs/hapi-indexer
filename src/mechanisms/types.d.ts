import { Request } from '@hapi/hapi';
import {
  PaginatedRequestQuery,
  PaginatedResponse,
} from '../storage/sqlite3/db/paginationUtils';
import {
  BlockRangeRequestQuery,
  BlockRangeResponse,
} from '../storage/sqlite3/db/blockRangeUtils';

export interface EndpointResponse<DataSets, Shape>
  extends Partial<PaginatedResponse>,
    BlockRangeResponse {
  shape?: Shape;
  data: DataSets;
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
