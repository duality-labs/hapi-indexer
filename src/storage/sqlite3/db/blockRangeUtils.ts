import { RequestQuery } from '@hapi/hapi';
import { getCompletedHeightAtTime } from './block/getHeight';
import { getLastBlockHeight } from '../../../sync';

export interface BlockRangeRequestQuery extends RequestQuery {
  // custom query parameters
  'block_range.from_timestamp'?: string; // unix timestamp
  'block_range.to_timestamp'?: string; // unix timestamp
  'block_range.from_height'?: string; // integer
  'block_range.to_height'?: string; // integer
}

interface BlockRangeInput {
  from_timestamp?: number; // unix timestamp from (non-incluse)
  to_timestamp?: number; // unix timestamp to (non-incluse)
  from_height?: number; // range from (non-incluse)
  to_height?: number; // range to (non-incluse)
}

// a block range is: `from_height` (non-inclusive) -> `to_height` (inclusive)
// this is so we can start at a known height `from_height`
// and craft a range that adds to that known height to reach a new `to_height`
export interface BlockRange {
  from_height: number; // range from (non-incluse)
  to_height: number; // range to (incluse)
}

export interface BlockRangeResponse {
  block_range: BlockRange;
}

function getBlockRangeInput(query: BlockRangeRequestQuery): BlockRangeInput {
  // collect possible keys into a user given object
  const unsafeRequest: Partial<BlockRangeInput> = {
    from_timestamp: Number(query['block_range.from_timestamp']) || undefined,
    to_timestamp: Number(query['block_range.to_timestamp']) || undefined,
    from_height: Number(query['block_range.from_height']) || undefined,
    to_height: Number(query['block_range.to_height']) || undefined,
  };

  // ensure some basic limits are respected
  return {
    // ensure number is positive
    // treat "0" as "no height set"
    from_timestamp: Math.max(0, unsafeRequest.from_timestamp ?? 0) || undefined,
    to_timestamp: Math.max(0, unsafeRequest.to_timestamp ?? 0) || undefined,
    from_height: Math.max(0, unsafeRequest.from_height ?? 0) || undefined,
    to_height: Math.max(0, unsafeRequest.to_height ?? 0) || undefined,
  };
}

// find the resolved block range that we wish to query
// todo: add some sort of restrictions so that we don't fetch millions of rows
//       eg. split up requests into smaller more cacheable chunks of data
export async function getBlockRange(
  query: BlockRangeRequestQuery,
  {
    // by default set query to known data
    maximumQueryBlockHeight = getLastBlockHeight(),
  } = {}
): Promise<BlockRange> {
  // get input in usable form
  const blockRangeInput = getBlockRangeInput(query);

  // determine block heights from given height or derived from timestamps or not
  // note: this limit translation of "to_timestamp" -> "to_height"
  //       will not resolve future timestamp blocks correctly (as they
  //       do not exist yet), and will resolve the current block height
  // todo: a better way to track "getData() time" than height would allow
  //       a better condition check as to when to exit the response loop
  //       and allow a 'to_timestamp' future time to be used and behave
  //       as expected and end when the time has passed (in block data)
  return {
    from_height: blockRangeInput.from_height
      ? // get block from given block
        Math.min(maximumQueryBlockHeight, blockRangeInput.from_height)
      : blockRangeInput.from_height
      ? // get block from timestamp
        await getCompletedHeightAtTime(blockRangeInput.from_height)
      : // default to querying from first block
        0,
    to_height: blockRangeInput.to_height
      ? // get block from given block
        Math.min(maximumQueryBlockHeight, blockRangeInput.to_height)
      : blockRangeInput.to_height
      ? // get block from timestamp
        await getCompletedHeightAtTime(blockRangeInput.to_height)
      : // default to querying up to last processed block
        maximumQueryBlockHeight,
  };
}
