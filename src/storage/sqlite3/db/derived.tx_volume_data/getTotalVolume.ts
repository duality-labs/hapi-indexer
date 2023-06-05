import sql from 'sql-template-strings';

import db from '../db';
import {
  PaginatedRequestQuery,
  getPaginationFromQuery,
} from '../paginationUtils';
import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';
import {
  PeriodType,
  Resolution,
  TimeseriesResponse,
  getOffsetSeconds,
  resolutionTimeFormats,
} from '../timeseriesUtils';

type AmountValues = [amountA: number, amountB: number];
type DataRow = [timeUnix: number, amounts: AmountValues];

export default async function getTotalVolume(
  tokenA: string,
  tokenB: string,
  resolution: Resolution,
  query: PaginatedRequestQuery = {},
  periodOffsetType?: PeriodType
): Promise<TimeseriesResponse<DataRow>> {
  // get asked for resolution or default to minute resolution
  const partitionTimeFormat =
    resolutionTimeFormats[resolution] || resolutionTimeFormats['minute'];

  // collect pagination keys into a pagination object
  const [pagination, getPaginationNextKey] = getPaginationFromQuery(query);
  const offsetSeconds = await getOffsetSeconds(pagination, periodOffsetType);

  // prepare statement at run time (after db has been initialized)
  const dataPromise: Promise<
    Array<{ time_unix: number; amount0: number; amount1: number }>
  > =
    db.all(sql`
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
        'block'.'header.time_unix' <= ${pagination.before} AND
        'block'.'header.time_unix' >= ${pagination.after} AND
        'derived.tx_volume_data'.'related.dex.pair' = (
          SELECT
            'dex.pairs'.'id'
          FROM
            'dex.pairs'
          WHERE (
            'dex.pairs'.'token0' = ${tokenA} AND
            'dex.pairs'.'token1' = ${tokenB}
          )
          OR (
            'dex.pairs'.'token1' = ${tokenA} AND
            'dex.pairs'.'token0' = ${tokenB}
          )
        )
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
    LIMIT ${pagination.limit + 1}
    OFFSET ${pagination.offset}
  `) ?? [];

  const invertedOrderPromise = hasInvertedOrder(tokenA, tokenB);
  const [data, invertedOrder] = await Promise.all([
    dataPromise,
    invertedOrderPromise,
  ]);

  // if result includes an item from the next page then remove it
  // and generate a next key to represent the next page of data
  const nextKey =
    data.length > pagination.limit
      ? (() => {
          // remove data item intended for next page
          data.pop();
          // create next page pagination options to be serialized
          return getPaginationNextKey(data.length);
        })()
      : null;

  return {
    shape: ['time_unix', [`amount ${tokenA}`, `amount ${tokenB}`]],
    data: data.map(
      // invert the indexes depend on which price ratio was asked for
      !invertedOrder
        ? (row): DataRow => {
            return [row['time_unix'], [row['amount0'], row['amount1']]];
          }
        : (row): DataRow => {
            return [row['time_unix'], [row['amount1'], row['amount0']]];
          }
    ),
    pagination: {
      next_key: nextKey,
    },
  };
}
