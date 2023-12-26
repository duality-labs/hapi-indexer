import { RequestQuery } from '@hapi/hapi';
import logger from '../../../logger';

export interface PaginatedRequestQuery extends RequestQuery {
  // replicated CosmosSDK keys
  'pagination.key'?: string; // base64 string key
  'pagination.offset'?: string; // integer
  'pagination.limit'?: string; // integer
  'pagination.count_total'?: string; // boolean
  // custom
  'block_range.from_timestamp'?: string; // unix timestamp
  'block_range.to_timestamp'?: string; // unix timestamp
}

export interface PaginationInput {
  offset: number;
  limit: number;
  from_timestamp: number; // unix timestamp
  to_timestamp: number; // unix timestamp
  count_total: boolean;
}

interface PaginationOutput {
  next_key: string | null;
  total?: number;
  totals?: number[]; // non-standard: show each total of multiple returned lists
}

export interface PaginatedResponse {
  pagination: PaginationOutput;
}

export function decodePagination(
  query: PaginatedRequestQuery,
  defaultPageSize = 1000
): Required<PaginationInput> {
  // collect pagination keys into a pagination object
  let unsafePagination: Partial<PaginationInput> = {
    offset: Number(query['pagination.offset']) || undefined,
    limit: Number(query['pagination.limit']) || undefined,
    from_timestamp: Number(query['block_range.from_timestamp']) || undefined,
    to_timestamp: Number(query['block_range.to_timestamp']) || undefined,
    count_total: query['pagination.count_total']
      ? query['pagination.count_total'] === 'true'
      : undefined,
  };
  // use pagination key to replace any other pagination options requested
  try {
    if (query['pagination.key']) {
      unsafePagination = JSON.parse(
        Buffer.from(query['pagination.key'], 'base64url').toString('utf8')
      );
    }
  } catch (e) {
    logger.error(e);
  }

  // ensure some basic pagination limits are respected
  return {
    offset: Math.max(0, unsafePagination.offset ?? 0),
    limit: Math.min(10000, unsafePagination.limit ?? defaultPageSize),
    from_timestamp: unsafePagination.from_timestamp ?? 0,
    to_timestamp:
      unsafePagination.to_timestamp ?? Math.floor(Date.now() / 1000),
    count_total: unsafePagination.count_total ?? false,
  };
}

// add callback to generate the next key from this request easily
const paginationKeys: Array<keyof PaginationInput> = [
  'offset',
  'limit',
  'from_timestamp',
  'to_timestamp',
];
function encodePaginationKey(
  pagination: Partial<PaginationInput>
): PaginationOutput['next_key'] {
  // whitelist only expected pagination keys
  const paginationProps = Object.fromEntries(
    Object.entries(pagination)
      // remove non-pagination keys
      .filter(([key]) => (paginationKeys as string[]).includes(key))
  );
  return Buffer.from(JSON.stringify(paginationProps)).toString('base64url');
}

export function getPaginationFromQuery(
  query: PaginatedRequestQuery,
  defaultPageSize?: number
): [
  pagination: PaginationInput,
  getNextKey: (offsetIncrease: number) => PaginationOutput['next_key']
] {
  // ensure some basic pagination limits are respected
  const pagination = decodePagination(query, defaultPageSize);

  // add callback to generate the next key from this request easily
  const getNextKey = (offsetIncrease = 0): PaginationOutput['next_key'] => {
    // add offset increase and return key
    if (offsetIncrease > 0) {
      return encodePaginationKey({
        // restrict offset and limit for more controlled next page behavior
        offset: pagination.offset + offsetIncrease,
        limit: pagination.limit,
        // pass height queries back in almost exactly as they came
        // (for consistent processing)
        from_timestamp:
          Number(query['block_range.from_timestamp']) || undefined,
        to_timestamp: Number(query['block_range.to_timestamp']) || undefined,
        count_total: Boolean(query['pagination.count_total']) || undefined,
      });
    }
    // otherwise return no new key
    return null;
  };

  return [pagination, getNextKey];
}

export function paginateData<T = unknown>(
  data: Array<T>,
  query: PaginatedRequestQuery,
  pageSize?: number
): [Array<T>, PaginationOutput] {
  // collect pagination keys into a pagination object
  const { offset, limit, ...pagination } = decodePagination(query, pageSize);

  // get this page
  const nextOffset = offset + limit;
  const page = data.slice(offset, nextOffset);
  // and generate a next key to represent the next page of data
  const nextKey =
    data.length > nextOffset
      ? encodePaginationKey({ ...pagination, offset: nextOffset, limit })
      : null;

  return [page, { next_key: nextKey, total: data.length }];
}
