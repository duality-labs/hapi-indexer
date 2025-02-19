import { RequestQuery } from '@hapi/hapi';

export interface BlockRangeRequestQuery extends RequestQuery {
  // custom query parameters
  'block_range.from_height'?: string; // integer
  'block_range.to_height'?: string; // integer
}

// a block range is: `from_height` (non-inclusive) -> `to_height` (inclusive)
// this is so we can start at a known height `from_height`
// and craft a range that adds to that known height to reach a new `to_height`
export interface BlockRange {
  from_height: number; // range from (non-incluse)
  to_height: number; // range to (inclusive)
}

export interface BlockRangeResponse {
  block_range: BlockRange;
}

export function getBlockRange(
  query: BlockRangeRequestQuery
): Partial<BlockRange> {
  // collect possible keys into a user given object
  const unsafeRequest: Partial<BlockRange> = {
    from_height: Number(query['block_range.from_height']) || undefined,
    to_height: Number(query['block_range.to_height']) || undefined,
  };

  // ensure some basic limits are respected
  return {
    // ensure number is positive
    // treat "0" as "no height set"
    from_height: Math.max(0, unsafeRequest.from_height ?? 0) || undefined,
    to_height: Math.max(0, unsafeRequest.to_height ?? 0) || undefined,
  };
}
