import sql from 'sql-template-strings';

import logger from '../../../../logger';
import db from '../db';
import { RequestQuery } from '@hapi/hapi';

interface UnsafePagination {
  offset?: number;
  limit?: number;
  before?: number;
  after?: number;
}
interface Pagination {
  offset: number;
  limit: number;
  before: number;
  after: number;
}

export default async function getPricePerSecond(
  tokenA: string,
  tokenB: string,
  query: RequestQuery = {}
) {
  // collect pagination keys into a pagination object
  let unsafePagination: UnsafePagination = {
    offset: Number(query['pagination.offset']) || undefined,
    limit: Number(query['pagination.limit']) || undefined,
    before: Number(query['pagination.before']) || undefined,
    after: Number(query['pagination.after']) || undefined,
  };
  // use pagination key to replace any other pagination options requested
  try {
    if (query['pagination.key']) {
      unsafePagination = JSON.parse(
        Buffer.from(query['pagination.key'], 'base64url').toString('utf8')
      );
    }
  } catch (e) {
    logger.error(e);
  }

  // ensure some basic pagination limits are respected
  const pagination: Pagination = {
    offset: Math.max(0, unsafePagination.offset ?? 0),
    limit: Math.min(1000, unsafePagination.limit ?? 100),
    before: unsafePagination.before ?? Math.floor(Date.now() / 1000),
    after: unsafePagination.after ?? 0,
  };

  // prepare statement at run time (after db has been initialized)
  const data = await db.all(sql`
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
  `);

  // if result includes an item from the next page then remove it
  // and generate a next key to represent the next page of data
  const nextKey =
    data && data.length > pagination.limit
      ? data.pop() &&
        Buffer.from(
          JSON.stringify({
            offset: pagination.offset + data.length,
            limit: pagination.limit,
            // pass height queries back in exactly as it came
            // (for consistent processing)
            ...(query['pagination.before'] && {
              before: query['pagination.before'],
            }),
            ...(query['pagination.after'] && {
              after: query['pagination.after'],
            }),
          })
        ).toString('base64url')
      : null;

  const shape = ['time_unix', ['open', 'high', 'low', 'close']];
  return {
    shape,
    data: (data || []).map((row) => {
      return [
        row['time_unix'],
        [row['open'], row['high'], row['low'], row['close']],
      ];
    }),
    pagination: {
      'next-key': nextKey,
    },
  };
}
