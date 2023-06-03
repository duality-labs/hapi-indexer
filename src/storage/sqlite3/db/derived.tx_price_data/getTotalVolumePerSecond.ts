import sql from 'sql-template-strings';

import db from '../db';
import {
  PaginatedRequestQuery,
  PaginatedResponse,
  getPaginationFromQuery,
} from '../paginationUtils';

const shape = ['time_unix', 'amount0', 'amount1'] as const;
type DataRow = [time_unix: number, amount0: number, amount1: number];

interface Response extends PaginatedResponse {
  shape: typeof shape;
  data: Array<DataRow>;
}

export default async function getTotalVolumePerSecond(
  tokenA: string,
  tokenB: string,
  query: PaginatedRequestQuery = {}
): Promise<Response> {
  // collect pagination keys into a pagination object
  const [pagination, getPaginationNextKey] = getPaginationFromQuery(query);

  // prepare statement at run time (after db has been initialized)
  const data: Array<{ time_unix: number; amount0: number; amount1: number }> =
    (await db.all(sql`
    WITH total_volume AS (
      SELECT
        'derived.tx_volume_data'.'block.header.time_unix' as 'time_unix',
        last_value('derived.tx_volume_data'.'ReservesFloat0')
          OVER seconds_window as 'last_amount_0',
        last_value('derived.tx_volume_data'.'ReservesFloat1')
          OVER seconds_window as 'last_amount_1'
      FROM
        'derived.tx_volume_data'
      WHERE
        'derived.tx_volume_data'.'meta.dex.pair' = (
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
        AND 'derived.tx_volume_data'.'block.header.time_unix' <= ${
          pagination.before
        }
        AND 'derived.tx_volume_data'.'block.header.time_unix' >= ${
          pagination.after
        }
      WINDOW seconds_window AS (
        ORDER BY 'derived.tx_volume_data'.'block.header.time_unix'
        GROUPS CURRENT ROW
      )
      ORDER BY
        'derived.tx_volume_data'.'block.header.time_unix' DESC,
        'derived.tx_volume_data'.'tx_result.events.index' DESC
    )
    SELECT
      'total_volume'.'time_unix' as 'time_unix',
      'total_volume'.'last_amount_0' as 'amount0',
      'total_volume'.'last_amount_1' as 'amount1'
    FROM
      'total_volume'
    GROUP BY
      'total_volume'.'time_unix'
    ORDER BY
      'total_volume'.'time_unix' DESC
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
    shape,
    data: data.map((row): DataRow => {
      return [row['time_unix'], row['amount0'], row['amount1']];
    }),
    pagination: {
      next_key: nextKey,
    },
  };
}
