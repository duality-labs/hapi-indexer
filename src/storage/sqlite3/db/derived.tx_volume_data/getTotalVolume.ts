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

type AmountValues = [amountA: number, amountB: number];
type DataRow = [timeUnix: number, amounts: AmountValues];

type DataSet = Array<DataRow>;
export type TotalVolumeTimeseries = DataSet;
export type TotalVolumeCache = Policy<DataSet, PolicyOptions<DataSet>>;

export const totalVolumeCache: PolicyOptions<DataSet> = {
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
          WITH windowed_table AS (
            SELECT
              unixepoch (
                strftime(
                  ${partitionTimeFormat},
                  'block'.'header.time_unix' - ${offsetSeconds},
                  'unixepoch'
                )
              ) + ${offsetSeconds} as 'resolution_unix',
              last_value('derived.tx_volume_data'.'ReservesFloat0')
                OVER resolution_window as 'last_amount_0',
              last_value('derived.tx_volume_data'.'ReservesFloat1')
                OVER resolution_window as 'last_amount_1'
            FROM
              'derived.tx_volume_data'
            INNER JOIN
              'tx_result.events'
            ON (
              'tx_result.events'.'id' = 'derived.tx_volume_data'.'related.tx_result.events'
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
              'derived.tx_volume_data'.'related.dex.pair' = (${selectSortedPairID(
                token0,
                token1
              )})
            WINDOW resolution_window AS (
              PARTITION BY strftime(
                ${partitionTimeFormat},
                'block'.'header.time_unix' - ${offsetSeconds},
                'unixepoch'
              )
              ORDER BY
                'derived.tx_volume_data'.'related.tx_result.events' ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            )
            ORDER BY
              'block'.'header.time_unix' DESC
          )
          SELECT
            'windowed_table'.'resolution_unix' as 'time_unix',
            'windowed_table'.'last_amount_0' as 'amount0',
            'windowed_table'.'last_amount_1' as 'amount1'
          FROM
            'windowed_table'
          GROUP BY
            'windowed_table'.'resolution_unix'
          ORDER BY
            'windowed_table'.'resolution_unix' DESC
        `)
      )
      // transform data for the tickIndexes to be in terms of A/B.
      .then((data) => {
        return data.map(
          // invert the indexes depend on which price ratio was asked for
          !reverseDirection
            ? (row): DataRow => {
                return [row['time_unix'], [row['amount0'], row['amount1']]];
              }
            : (row): DataRow => {
                return [row['time_unix'], [row['amount1'], row['amount0']]];
              }
        );
      });
  },
  generateTimeout: 1000 * 20,
};

type HeightedTotalVolume = [height: number, data: DataSet];

export async function getTotalVolumeTimeseries(
  totalVolumeCache: TotalVolumeCache,
  token0: string,
  token1: string,
  tokenIn: string,
  resolution: Resolution,
  query: PaginatedRequestQuery = {},
  periodOffsetType?: PeriodType
): Promise<HeightedTotalVolume | null> {
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
  const data = await totalVolumeCache.get(cacheKey);
  return data ? [toHeight, data] : null;
}

export async function getUnsortedTotalVolumeTimeseries(
  totalVolumeCache: TotalVolumeCache,
  tokenA: string,
  tokenB: string,
  resolution: Resolution,
  query: PaginatedRequestQuery = {},
  periodOffsetType?: PeriodType
): Promise<HeightedTotalVolume | null> {
  const invertedOrder = await hasInvertedOrder(tokenA, tokenB);
  const token0 = invertedOrder ? tokenB : tokenA;
  const token1 = invertedOrder ? tokenA : tokenB;
  return getTotalVolumeTimeseries(
    totalVolumeCache,
    token0,
    token1,
    tokenA,
    resolution,
    query,
    periodOffsetType
  );
}
