import sql from 'sql-template-strings';

import db from '../db';
import {
  PaginatedRequestQuery,
  getPaginationFromQuery,
} from '../paginationUtils';
import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';
import {
  Resolution,
  TimeseriesResponse,
  resolutionTimeFormats,
} from '../timeseriesUtils';

type AmountValues = [amountA: number, amountB: number];
type DataRow = [timeUnix: number, amounts: AmountValues];

export default async function getSwapVolume(
  tokenA: string,
  tokenB: string,
  resolution: Resolution,
  query: PaginatedRequestQuery = {}
): Promise<TimeseriesResponse<DataRow>> {
  // get asked for resolution or default to minute resolution
  const partitionTimeFormat =
    resolutionTimeFormats[resolution] || resolutionTimeFormats['minute'];

  // collect pagination keys into a pagination object
  const [pagination, getPaginationNextKey] = getPaginationFromQuery(query);

  // prepare statement at run time (after db has been initialized)
  const dataPromise: Promise<
    Array<{ time_unix: number; amount0: number; amount1: number }>
  > =
    db.all(sql`
    WITH 'ungrouped_table' AS (
      SELECT
        unixepoch (
          strftime(
            ${partitionTimeFormat},
            'block'.'header.time'
          )
        ) as 'resolution_unix',
        -- select only the withdrawn reserves for token0
        (
          CASE
            WHEN (
              'event.TickUpdate'.'TokenIn' = 'event.TickUpdate'.'Token0' AND
              'event.TickUpdate'.'derived.ReservesDiff' < 0
            )
            THEN CAST('event.TickUpdate'.'derived.ReservesDiff' as FLOAT)
            ELSE 0
          END
        ) as 'swap_amount_0',
        -- select only the withdrawn reserves for token1
        (
          CASE
            WHEN (
              'event.TickUpdate'.'TokenIn' = 'event.TickUpdate'.'Token1' AND
              'event.TickUpdate'.'derived.ReservesDiff' < 0
            )
            THEN CAST('event.TickUpdate'.'derived.ReservesDiff' as FLOAT)
            ELSE 0
          END
        ) as 'swap_amount_1'
      FROM
        'event.TickUpdate'
      INNER JOIN
        'tx_result.events'
      ON (
        'tx_result.events'.'id' = 'event.TickUpdate'.'related.tx_result.events'
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
        'event.TickUpdate'.'related.dex.pair' = (
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
    )
    SELECT
      'ungrouped_table'.'resolution_unix' as 'time_unix',
      sum('ungrouped_table'.'swap_amount_0') as 'amount0',
      sum('ungrouped_table'.'swap_amount_1') as 'amount1'
    FROM
      'ungrouped_table'
    GROUP BY
      'ungrouped_table'.'resolution_unix'
    HAVING
      sum('ungrouped_table'.'swap_amount_0') != 0 OR
      sum('ungrouped_table'.'swap_amount_1') != 0
    ORDER BY
      'ungrouped_table'.'resolution_unix' DESC
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
      // show negative withdrawal volume as just absolute "volume"
      // also convert any null sums to 0
      !invertedOrder
        ? ({ time_unix: timeUnix, amount0, amount1 }): DataRow => {
            return [timeUnix, [-amount0 || 0, -amount1 || 0]];
          }
        : ({ time_unix: timeUnix, amount0, amount1 }): DataRow => {
            return [timeUnix, [-amount1 || 0, -amount0 || 0]];
          }
    ),
    pagination: {
      next_key: nextKey,
    },
  };
}
