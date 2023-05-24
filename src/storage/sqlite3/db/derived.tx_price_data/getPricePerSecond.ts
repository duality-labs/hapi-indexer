import sql from 'sql-template-strings';

import db from '../db';
import {
  PaginatedRequestQuery,
  PaginatedResponse,
  getPaginationFromQuery,
} from '../paginationUtils';

type Shape = [string, [string, string, string, string]];
type DataRow = [number, [number, number, number, number]];

interface Response extends PaginatedResponse {
  shape: Shape;
  data: Array<DataRow>;
}

export default async function getPricePerSecond(
  tokenA: string,
  tokenB: string,
  query: PaginatedRequestQuery = {}
): Promise<Response> {
  // collect pagination keys into a pagination object
  const [pagination, getPaginationNextKey] = getPaginationFromQuery(query);

  // prepare statement at run time (after db has been initialized)
  const data: Array<{ [key: string]: number }> =
    (await db.all(sql`
    WITH price_points AS (
      SELECT
        'derived.tx_price_data'.'block.header.time_unix' as 'time_unix',
        first_value('derived.tx_price_data'.'LastTick')
          OVER seconds_window as 'first_price',
        last_value('derived.tx_price_data'.'LastTick')
          OVER seconds_window as 'last_price',
        'derived.tx_price_data'.'LastTick' as 'price'
      FROM
        'derived.tx_price_data'
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
      WINDOW seconds_window AS (
        ORDER BY 'derived.tx_price_data'.'block.header.time_unix'
        GROUPS CURRENT ROW
      )
      ORDER BY
        'derived.tx_price_data'.'block.header.time_unix' DESC,
        'derived.tx_price_data'.'tx_result.events.index' DESC
    )
    SELECT
      'price_points'.'time_unix' as 'time_unix',
      'price_points'.'first_price' as 'open',
      'price_points'.'last_price' as 'close',
      min('price_points'.'price') as 'low',
      max('price_points'.'price') as 'high'
    FROM
      'price_points'
    GROUP BY
      'price_points'.'time_unix'
    ORDER BY
      'price_points'.'time_unix' DESC
    LIMIT ${pagination.limit + 1}
    OFFSET ${pagination.offset}
  `)) ?? [];

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

  const shape: Shape = ['time_unix', ['open', 'high', 'low', 'close']];
  return {
    shape,
    data: data.map((row): DataRow => {
      return [
        row['time_unix'],
        [row['open'], row['high'], row['low'], row['close']],
      ];
    }),
    pagination: {
      next_key: nextKey,
    },
  };
}
