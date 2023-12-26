import sql from 'sql-template-tag';
import { Policy, PolicyOptions } from '@hapi/catbox';

import db, { prepare } from '../db';
import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';
import {
  PaginatedRequestQuery,
  getPaginationFromQuery,
} from '../paginationUtils';
import {
  PeriodType,
  Resolution,
  getOffsetSeconds,
  resolutionTimeFormats,
} from '../timeseriesUtils';
import { selectSortedPairID } from '../dex.pairs/selectPairID';
import { getLastBlockHeight } from '../../../../sync';
import { getCompletedHeightAtTime } from '../block/getHeight';
import { getBlockRange } from '../blockRangeUtils';
import {
  selectTimeUnixAfterBlockHeight,
  selectTimeUnixAtOrBeforeBlockHeight,
} from '../block/selectTimeUnix';

type AmountValues = [
  amountA: number,
  amountB: number,
  feeA: number,
  feeB: number
];
type DataRow = [timeUnix: number, amounts: AmountValues];

type DataSet = Array<DataRow>;
export type SwapVolumeTimeseries = DataSet;
export type SwapVolumeCache = Policy<DataSet, PolicyOptions<DataSet>>;

export const swapVolumeCache: PolicyOptions<DataSet> = {
  expiresIn: 1000 * 60, // allow for a few block heights
  generateFunc: async (id) => {
    const [token0, token1, tokenIn, partitionTimeFormat] = `${id}`.split('|');
    const [offsetSeconds, fromHeight, toHeight] = `${id}`
      .split('|')
      .slice(4)
      .map(Number);
    if (!token0 || !token1) {
      throw new Error('Tokens not specified', { cause: 400 });
    }
    // it is important that the cache is called with height restrictions:
    // this ensures that the result is deterministic and can be cached
    // indefinitely (an unbound height result may change with time)
    if (fromHeight === undefined || toHeight === undefined) {
      throw new Error('Height restrictions are required', { cause: 400 });
    }
    const lastBlockHeight = getLastBlockHeight();
    if (fromHeight > lastBlockHeight || toHeight > lastBlockHeight) {
      throw new Error('Height is not bound to known data', { cause: 400 });
    }
    if (toHeight < fromHeight) {
      throw new Error('Height query will produce no data', { cause: 400 });
    }
    // if heights are equal, return empty data without doing DB call
    // note: easy to do if you're querying a time period earlier than the chain
    //       where a request produces: { fromHeight: 0, toHeight: 0 }
    if (fromHeight === toHeight) {
      return [];
    }

    // return the result set
    const reverseDirection = token1 === tokenIn;
    return await db
      .all(
        ...prepare(sql`
          WITH 'ungrouped_table' AS (
            SELECT
              unixepoch (
                strftime(
                  ${partitionTimeFormat},
                  'block'.'header.time_unix' - ${offsetSeconds},
                  'unixepoch'
                )
              ) + ${offsetSeconds} as 'resolution_unix',
              -- select only the deposited reserves for token0
              (
                CASE
                  WHEN (
                    'event.TickUpdate'.'TokenIn' = 'event.TickUpdate'.'TokenZero' AND
                    'event.TickUpdate'.'derived.ReservesDiff' > 0
                  )
                  THEN CAST('event.TickUpdate'.'derived.ReservesDiff' as FLOAT)
                  ELSE 0
                END
              ) as 'swap_amount_0',
              -- select only the calculated deposit fee for token0 deposits
              (
                CASE
                  WHEN (
                    'event.TickUpdate'.'TokenIn' = 'event.TickUpdate'.'TokenZero' AND
                    'event.TickUpdate'.'derived.ReservesDiff' > 0
                  )
                  THEN (
                    CAST('event.TickUpdate'.'derived.ReservesDiff' as FLOAT) *
                    'event.TickUpdate'.'Fee' / 10000
                  )
                  ELSE 0
                END
              ) as 'swap_fee_0',
              -- select only the deposited reserves for token1
              (
                CASE
                  WHEN (
                    'event.TickUpdate'.'TokenIn' = 'event.TickUpdate'.'TokenOne' AND
                    'event.TickUpdate'.'derived.ReservesDiff' > 0
                  )
                  THEN CAST('event.TickUpdate'.'derived.ReservesDiff' as FLOAT)
                  ELSE 0
                END
              ) as 'swap_amount_1',
              -- select only the calculated deposit fee for token1 deposits
              (
                CASE
                  WHEN (
                    'event.TickUpdate'.'TokenIn' = 'event.TickUpdate'.'TokenOne' AND
                    'event.TickUpdate'.'derived.ReservesDiff' > 0
                  )
                  THEN (
                    CAST('event.TickUpdate'.'derived.ReservesDiff' as FLOAT) *
                    'event.TickUpdate'.'Fee' / 10000
                  )
                  ELSE 0
                END
              ) as 'swap_fee_1'
            FROM
              'event.TickUpdate'
            INNER JOIN
              'tx_result.events'
            ON (
              'tx_result.events'.'id' = 'event.TickUpdate'.'related.tx_result.events'
            )
            INNER JOIN
              'tx_msg'
            ON (
              'tx_msg'.'id' = 'tx_result.events'.'related.tx_msg'
            )
            INNER JOIN
              'tx_msg_type'
            ON (
              'tx_msg_type'.'id' = 'tx_msg'.'related.tx_msg_type'
            )
            INNER JOIN
              'tx'
            ON (
              'tx'.'id' = 'tx_result.events'.'related.tx'
            )
            INNER JOIN
              'block'
            ON (
              'block'.'id' = 'tx'.'related.block'
            )
            WHERE
              -- restrict to time
              -- ensure that the full time partition is included in calculation
              -- by rounding down the start time to the start of the partition
              'block'.'header.time_unix' >= unixepoch(
                strftime(
                  ${partitionTimeFormat},
                  ${selectTimeUnixAfterBlockHeight(fromHeight)},
                  'unixepoch'
                )
              ) AND
              'block'.'header.time_unix' <= (
                ${selectTimeUnixAtOrBeforeBlockHeight(toHeight)}
              ) AND
              -- restrict to pair
              'event.TickUpdate'.'related.dex.pair' = (${selectSortedPairID(
                token0,
                token1
              )}) AND
              -- restrict to tx Msg type
              'tx_msg_type'.'action' = "neutron.dex.MsgPlaceLimitOrder"
          )
          SELECT
            'ungrouped_table'.'resolution_unix' as 'time_unix',
            sum('ungrouped_table'.'swap_amount_0') as 'amount0',
            sum('ungrouped_table'.'swap_amount_1') as 'amount1',
            sum('ungrouped_table'.'swap_fee_0') as 'fee0',
            sum('ungrouped_table'.'swap_fee_1') as 'fee1'
          FROM
            'ungrouped_table'
          GROUP BY
            'ungrouped_table'.'resolution_unix'
          HAVING
            -- ignore empty rows
            sum('ungrouped_table'.'swap_amount_0') > 0 OR
            sum('ungrouped_table'.'swap_amount_1') > 0
          ORDER BY
            'ungrouped_table'.'resolution_unix' DESC
        `)
      )
      // transform data for the tickIndexes to be in terms of A/B.
      .then((data) => {
        return data.map(
          // invert the indexes depend on which price ratio was asked for
          !reverseDirection
            ? ({
                time_unix: timeUnix,
                amount0,
                amount1,
                fee0,
                fee1,
              }): DataRow => {
                return [timeUnix, [amount0, amount1, fee0, fee1]];
              }
            : ({
                time_unix: timeUnix,
                amount0,
                amount1,
                fee0,
                fee1,
              }): DataRow => {
                return [timeUnix, [amount1, amount0, fee1, fee0]];
              }
        );
      });
  },
  generateTimeout: 1000 * 20,
};

type HeightedSwapVolume = [height: number, data: DataSet];

export async function getSwapVolumeTimeseries(
  swapVolumeCache: SwapVolumeCache,
  token0: string,
  token1: string,
  tokenIn: string,
  resolution: Resolution,
  query: PaginatedRequestQuery = {},
  periodOffsetType?: PeriodType
): Promise<HeightedSwapVolume | null> {
  // get asked for resolution or default to minute resolution
  const partitionTimeFormat =
    resolutionTimeFormats[resolution] || resolutionTimeFormats['minute'];

  // collect pagination keys into a pagination object
  const [pagination] = getPaginationFromQuery(query);
  const offsetSeconds = await getOffsetSeconds(pagination, periodOffsetType);

  const blockRange = getBlockRange(query);
  // todo: add some sort of restrictions so that we don't fetch millions of rows
  const currentHeight = getLastBlockHeight();
  const [fromHeight = 0, toHeight = currentHeight] = await Promise.all([
    // prioritize block_range over pagination query params
    blockRange.from_height ?? getCompletedHeightAtTime(pagination.after),
    blockRange.to_height ?? getCompletedHeightAtTime(pagination.before),
  ])
    // restrict heights to the maximum of the last processed block
    // (ie. don't include data from partially ingested blocks)
    .then((heights) =>
      heights.map((height) => Math.min(height, currentHeight))
    );

  // get prices through cache
  const cacheKey = [
    token0,
    token1,
    tokenIn,
    partitionTimeFormat,
    offsetSeconds,
    fromHeight,
    toHeight,
  ].join('|');
  const data = await swapVolumeCache.get(cacheKey);
  return data ? [toHeight, data] : null;
}

export async function getUnsortedSwapVolumeTimeseries(
  swapVolumeCache: SwapVolumeCache,
  tokenA: string,
  tokenB: string,
  resolution: Resolution,
  query: PaginatedRequestQuery = {},
  periodOffsetType?: PeriodType
): Promise<HeightedSwapVolume | null> {
  const invertedOrder = await hasInvertedOrder(tokenA, tokenB);
  const token0 = invertedOrder ? tokenB : tokenA;
  const token1 = invertedOrder ? tokenA : tokenB;
  return getSwapVolumeTimeseries(
    swapVolumeCache,
    token0,
    token1,
    tokenA,
    resolution,
    query,
    periodOffsetType
  );
}
