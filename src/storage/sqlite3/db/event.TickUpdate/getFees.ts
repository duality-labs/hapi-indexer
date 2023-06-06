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

export default async function getFees(
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
    WITH 'ungrouped_table' AS (
      SELECT
        unixepoch (
          strftime(
            ${partitionTimeFormat},
            'block'.'header.time_unix' - ${offsetSeconds},
            'unixepoch'
          )
        ) + ${offsetSeconds} as 'resolution_unix',
        -- select only the calculated deposit fee for token0 deposits
        (
          CASE
            WHEN (
              'event.TickUpdate'.'TokenIn' = 'event.TickUpdate'.'Token0' AND
              'event.TickUpdate'.'derived.ReservesDiff' > 0
            )
            THEN (
              CAST('event.TickUpdate'.'derived.ReservesDiff' as FLOAT) *
              'event.TickUpdate'.'Fee' / 10000
            )
            ELSE 0
          END
        ) as 'swap_amount_0',
        -- select only the calculated deposit fee for token1 deposits
        (
          CASE
            WHEN (
              'event.TickUpdate'.'TokenIn' = 'event.TickUpdate'.'Token1' AND
              'event.TickUpdate'.'derived.ReservesDiff' > 0
            )
            THEN (
              CAST('event.TickUpdate'.'derived.ReservesDiff' as FLOAT) *
              'event.TickUpdate'.'Fee' / 10000
            )
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
        'block'.'header.time_unix' <= ${pagination.before} AND
        'block'.'header.time_unix' >= ${pagination.after} AND
        -- restrict to pair
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
        ) AND
        -- restrict to tx Msg type
        'tx_msg_type'.'action' = "dualitylabs.duality.dex.MsgPlaceLimitOrder"
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
      -- ignore empty rows
      sum('ungrouped_table'.'swap_amount_0') > 0 OR
      sum('ungrouped_table'.'swap_amount_1') > 0
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
      !invertedOrder
        ? ({ time_unix: timeUnix, amount0, amount1 }): DataRow => {
            return [timeUnix, [amount0, amount1]];
          }
        : ({ time_unix: timeUnix, amount0, amount1 }): DataRow => {
            return [timeUnix, [amount1, amount0]];
          }
    ),
    pagination: {
      next_key: nextKey,
    },
  };
}
