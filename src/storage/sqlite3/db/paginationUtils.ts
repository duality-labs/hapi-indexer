import { RequestQuery } from '@hapi/hapi';
import logger from '../../../logger';

export interface PaginatedRequestQuery extends RequestQuery {
  'pagination.key'?: string;
  'pagination.offset'?: string;
  'pagination.limit'?: number;
  'pagination.before'?: number; // unix timestamp
  'pagination.after'?: number; // unix timestamp
}

interface PaginationInput {
  offset?: number;
  limit?: number;
  before?: number; // unix timestamp
  after?: number; // unix timestamp
}

interface PaginationOutput {
  next_key: string | null;
}

export interface PaginatedResponse {
  pagination: PaginationOutput;
}

export function getPaginationFromQuery(
  query: PaginatedRequestQuery
): [
  pagination: Required<PaginationInput>,
  getNextKey: (offsetIncrease: number) => PaginationOutput['next_key']
] {
  // collect pagination keys into a pagination object
  let unsafePagination: PaginationInput = {
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
  const pagination: Required<PaginationInput> = {
    offset: Math.max(0, unsafePagination.offset ?? 0),
    limit: Math.min(1000, unsafePagination.limit ?? 100),
    before: unsafePagination.before ?? Math.floor(Date.now() / 1000),
    after: unsafePagination.after ?? 0,
  };

  // add callback to generate the next key from this request easily
  const getNextKey = (offsetIncrease = 0): PaginationOutput['next_key'] => {
    // add offset increase and return key
    if (offsetIncrease > 0) {
      const nextPagination: PaginationInput = {
        offset: pagination.offset + offsetIncrease,
        limit: pagination.limit,
        // pass height queries back in exactly as it came
        // (for consistent processing)
        before: query['pagination.before'],
        after: query['pagination.after'],
      };
      return Buffer.from(JSON.stringify(nextPagination)).toString('base64url');
    }
    // otherwise return no new key
    return null;
  };

  return [pagination, getNextKey];
}
