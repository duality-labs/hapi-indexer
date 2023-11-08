import sql from 'sql-template-tag';

import db, { prepare } from '../db';
import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';
import {
  PaginatedRequestQuery,
  getPaginationFromQuery,
} from '../paginationUtils';
import {
  PeriodType,
  Resolution,
  TimeseriesResponse,
  getOffsetSeconds,
  resolutionTimeFormats,
} from '../timeseriesUtils';
import { selectPairID } from '../dex.pairs/selectPairID';

type TickIndex = number | null;
type PriceValues = [
  open: TickIndex,
  high: TickIndex,
  low: TickIndex,
  close: TickIndex
];
type DataRow = [time_unix: number, prices: PriceValues];

export default async function getPrice(
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
  const dataPromise: Promise<Array<{ [key: string]: number }>> =
    db.all(
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
        first_value('derived.tx_price_data'.'LastTick')
          OVER resolution_window as 'first_price',
        last_value('derived.tx_price_data'.'LastTick')
          OVER resolution_window as 'last_price',
        'derived.tx_price_data'.'LastTick' as 'price'
      FROM
        'derived.tx_price_data'
      INNER JOIN
        'tx_result.events'
      ON (
        'tx_result.events'.'id' = 'derived.tx_price_data'.'related.tx_result.events'
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
        'derived.tx_price_data'.'related.dex.pair' = (${selectPairID(
          tokenA,
          tokenB
        )})
      WINDOW resolution_window AS (
        PARTITION BY strftime(
          ${partitionTimeFormat},
          'block'.'header.time_unix' - ${offsetSeconds},
          'unixepoch'
        )
        ORDER BY
          'derived.tx_price_data'.'related.tx_result.events' ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      )
      ORDER BY
        'block'.'header.time_unix' DESC
    )
    SELECT
      'windowed_table'.'resolution_unix' as 'time_unix',
      'windowed_table'.'first_price' as 'open',
      'windowed_table'.'last_price' as 'close',
      min('windowed_table'.'price') as 'low',
      max('windowed_table'.'price') as 'high'
    FROM
      'windowed_table'
    GROUP BY
      'windowed_table'.'resolution_unix'
    ORDER BY
      'windowed_table'.'resolution_unix' DESC
    LIMIT ${pagination.limit + 1}
    OFFSET ${pagination.offset}
      `)
    ) ?? [];

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
    shape: ['time_unix', ['open', 'high', 'low', 'close']],
    data: data.map(
      // invert the indexes depending on which price ratio was asked for
      !invertedOrder
        ? (row): DataRow => {
            return [
              row['time_unix'],
              [row['open'], row['high'], row['low'], row['close']],
            ];
          }
        : (row): DataRow => {
            return [
              row['time_unix'],
              // invert the indexes for the asked for price ratio
              [row['open'], row['high'], row['low'], row['close']].map(
                (value) => (value !== null ? -value : null)
              ) as PriceValues,
            ];
          }
    ),
    pagination: {
      next_key: nextKey,
    },
  };
}
