import { RequestQuery } from '@hapi/hapi';
import logger from '../../../logger';

export interface PaginatedRequestQuery extends RequestQuery {
  'pagination.key'?: string;
  'pagination.offset'?: string;
  'pagination.limit'?: string;
  'pagination.before'?: string; // unix timestamp
  'pagination.after'?: string; // unix timestamp
}

export interface PaginationInput {
  offset: number;
  limit: number;
  before: number; // unix timestamp
  after: number; // unix timestamp
}

interface PaginationOutput {
  next_key: string | null;
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
    before: Number(query['pagination.before']) || undefined,
    after: Number(query['pagination.after']) || undefined,
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
    before: unsafePagination.before ?? Math.floor(Date.now() / 1000),
    after: unsafePagination.after ?? 0,
  };
}

// add callback to generate the next key from this request easily
export function encodePaginationKey(
  pagination: Partial<PaginationInput>
): PaginationOutput['next_key'] {
  return Buffer.from(JSON.stringify(pagination)).toString('base64url');
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
        before: Number(query['pagination.before']) || undefined,
        after: Number(query['pagination.after']) || undefined,
      });
    }
    // otherwise return no new key
    return null;
  };

  return [pagination, getNextKey];
}
