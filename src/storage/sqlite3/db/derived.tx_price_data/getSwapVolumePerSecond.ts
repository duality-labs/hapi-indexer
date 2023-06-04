import sql from 'sql-template-strings';

import db from '../db';
import {
  PaginatedRequestQuery,
  PaginatedResponse,
  getPaginationFromQuery,
} from '../paginationUtils';

export type AmountValues = [amountA: number, amountB: number];
export type DataRow = [timeUnix: number, amounts: AmountValues];

interface Response extends PaginatedResponse {
  shape: ['time_unix', string, string];
  data: Array<DataRow>;
}

export default async function getSwapVolumePerSecond(
  tokenA: string,
  tokenB: string,
  query: PaginatedRequestQuery = {}
): Promise<Response> {
  // collect pagination keys into a pagination object
  const [pagination, getPaginationNextKey] = getPaginationFromQuery(query);

  // prepare statement at run time (after db has been initialized)
  const data: Array<{ time_unix: number; amount: string; token: string }> =
    (await db.all(sql`
    WITH swap_volume AS (
      SELECT
        'block'.'header.time_unix' as 'time_unix',
        CAST ('event.PlaceLimitOrder'.'AmountIn' AS FLOAT) as 'amount',
        'event.PlaceLimitOrder'.'TokenIn' as 'token'
      FROM
        'event.PlaceLimitOrder'
      INNER JOIN
        'block'
      ON (
        'block'.'id' = 'event.PlaceLimitOrder'.'related.block'
      )
      WHERE
        'block'.'header.time_unix' <= ${pagination.before} AND
        'block'.'header.time_unix' >= ${pagination.after} AND
        'event.PlaceLimitOrder'.'related.dex.pair' = (
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
      'swap_volume'.'time_unix' as 'time_unix',
      SUM('swap_volume'.'amount') as 'amount',
      'swap_volume'.'token' as 'token'
    FROM
      'swap_volume'
    GROUP BY
      'swap_volume'.'time_unix',
      'swap_volume'.'token'
    ORDER BY
      'swap_volume'.'time_unix' DESC
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

  return {
    shape: ['time_unix', `amount ${tokenA}`, `amount ${tokenB}`],
    data: data.map((row): DataRow => {
      return [
        row['time_unix'],
        // convert to float precision here
        [
          row['token'] === tokenA ? Number(row['amount']) : 0,
          row['token'] === tokenB ? Number(row['amount']) : 0,
        ],
      ];
    }),
    pagination: {
      next_key: nextKey,
    },
  };
}
