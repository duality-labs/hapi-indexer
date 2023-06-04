import sql from 'sql-template-strings';

import db from '../db';
import {
  PaginatedRequestQuery,
  PaginatedResponse,
  getPaginationFromQuery,
} from '../paginationUtils';
import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';
import { Resolution, resolutionTimeFormats } from './utils';

type AmountValues = [amountA: number, amountB: number];
type DataRow = [timeUnix: number, amounts: AmountValues];

const shape = ['time_unix', 'amount0', 'amount1'];

interface Response extends PaginatedResponse {
  shape: typeof shape;
  data: Array<DataRow>;
}

export default async function getTotalVolume(
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
  const dataPromise: Promise<
    Array<{ time_unix: number; amount0: number; amount1: number }>
  > =
    db.all(sql`
    WITH windowed_table AS (
      SELECT
        unixepoch (
          strftime(
            ${partitionTimeFormat},
            'block'.'header.time'
          )
        ) as 'resolution_unix',
        last_value('derived.tx_volume_data'.'ReservesFloat0')
          OVER resolution_window as 'last_amount_0',
        last_value('derived.tx_volume_data'.'ReservesFloat1')
          OVER resolution_window as 'last_amount_1'
      FROM
        'derived.tx_volume_data'
      INNER JOIN
        'block'
      ON (
        'block'.'header.height' = 'derived.tx_volume_data'.'block.header.height'
      )
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
      WINDOW resolution_window AS (
        PARTITION BY strftime(
          ${partitionTimeFormat},
          'block'.'header.time'
        )
        ORDER BY
          'derived.tx_volume_data'.'block.header.time_unix' ASC,
          'derived.tx_volume_data'.'tx_result.events.index' ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
      )
      ORDER BY
        'derived.tx_volume_data'.'block.header.time_unix' DESC
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
    shape: ['time_unix', `amount ${tokenA}`, `amount ${tokenB}`],
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
