import sql from 'sql-template-strings';

import db from '../db';
import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';
import {
  PaginatedRequestQuery,
  PaginatedResponse,
  getPaginationFromQuery,
} from '../paginationUtils';
import { Resolution, resolutionTimeFormats } from './utils';

type PriceValues = [open: number, high: number, low: number, close: number];
type DataRow = [time_unix: number, prices: PriceValues];

const shape = ['time_unix', ['open', 'high', 'low', 'close']] as const;

interface Response extends PaginatedResponse {
  shape: typeof shape;
  data: Array<DataRow>;
}

export default async function getPrice(
  tokenA: string,
  tokenB: string,
  resolution: Resolution,
  query: PaginatedRequestQuery = {}
): Promise<Response> {
  // get asked for resolution or default to minute resolution
  const partitionTimeFormat =
    resolutionTimeFormats[resolution] || resolutionTimeFormats['minute'];

  // collect pagination keys into a pagination object
  const [pagination, getPaginationNextKey] = getPaginationFromQuery(query);

  // prepare statement at run time (after db has been initialized)
  const dataPromise: Promise<Array<{ [key: string]: number }>> =
    db.all(sql`
    WITH price_points AS (
      SELECT
        unixepoch (
          strftime(
            ${partitionTimeFormat},
            'block'.'header.time'
          )
        ) as 'resolution_unix',
        first_value('derived.tx_price_data'.'LastTick')
          OVER resolution_window as 'first_price',
        last_value('derived.tx_price_data'.'LastTick')
          OVER resolution_window as 'last_price',
        'derived.tx_price_data'.'LastTick' as 'price'
      FROM
        'derived.tx_price_data'
      INNER JOIN
        'block'
      ON (
        'block'.'header.height' = 'derived.tx_price_data'.'block.header.height'
      )
      WHERE
        'derived.tx_price_data'.'meta.dex.pair' = (
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
        AND 'derived.tx_price_data'.'block.header.time_unix' <= ${
          pagination.before
        }
        AND 'derived.tx_price_data'.'block.header.time_unix' >= ${
          pagination.after
        }
      WINDOW resolution_window AS (
        PARTITION BY strftime(
          ${partitionTimeFormat},
          'block'.'header.time'
        )
        ORDER BY
          'derived.tx_price_data'.'block.header.time_unix' ASC,
          'derived.tx_price_data'.'tx_result.events.index' ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      )
      ORDER BY
        'derived.tx_price_data'.'block.header.time_unix' DESC
    )
    SELECT
      'price_points'.'resolution_unix' as 'time_unix',
      'price_points'.'first_price' as 'open',
      'price_points'.'last_price' as 'close',
      min('price_points'.'price') as 'low',
      max('price_points'.'price') as 'high'
    FROM
      'price_points'
    GROUP BY
      'price_points'.'resolution_unix'
    ORDER BY
      'price_points'.'resolution_unix' DESC
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
    shape,
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
              [-row['open'], -row['high'], -row['low'], -row['close']],
            ];
          }
    ),
    pagination: {
      next_key: nextKey,
    },
  };
}
