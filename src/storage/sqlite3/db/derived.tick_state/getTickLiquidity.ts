import BigNumber from 'bignumber.js';
import sql from 'sql-template-strings';

import db from '../db';
import hasInvertedOrder from '../dex.pairs/hasInvertedOrder';
import {
  PaginatedRequestQuery,
  PaginatedResponse,
  getPaginationFromQuery,
} from '../paginationUtils';

type DataRow = [tick_index: number, reserves: number];

interface TickLiquidityResponse extends PaginatedResponse {
  shape: ['tick_index', 'reserves'];
  data: Array<DataRow>;
}

export default async function getTokenTickLiquidity(
  tokenA: string,
  tokenB: string,
  query: PaginatedRequestQuery = {}
): Promise<TickLiquidityResponse> {
  // collect pagination keys into a pagination object
  const [pagination, getPaginationNextKey] = getPaginationFromQuery(query);

  // fetch if the order is inverted to order the data and pages correctly
  const invertedOrder = await hasInvertedOrder(tokenA, tokenB);

  // prepare statement at run time (after db has been initialized)
  const data: Array<{ [key: string]: number }> =
    invertedOrder !== undefined
      ? (await db.all(
          sql`
            SELECT
              'derived.tick_state'.'TickIndex' as 'tickIndex',
              'derived.tick_state'.'Reserves' as 'reserves'
            FROM
              'derived.tick_state'
            WHERE (
              'derived.tick_state'.'related.dex.pair' = (
                SELECT
                  'dex.pairs'.'id'
                FROM
                  'dex.pairs'
                WHERE (
                  'dex.pairs'.'token0' = ${tokenA} AND
                  'dex.pairs'.'token1' = ${tokenB}
                ) OR (
                  'dex.pairs'.'token1' = ${tokenA} AND
                  'dex.pairs'.'token0' = ${tokenB}
                )
              ) AND
              'derived.tick_state'.'related.dex.token' = (
                SELECT
                  'dex.tokens'.'id'
                FROM
                  'dex.tokens'
                WHERE (
                  'dex.tokens'.'Token' = ${tokenA}
                )
              ) AND
              'derived.tick_state'.'Reserves' != '0'
            )`.append(`--sql
              -- add dynamic ordering
              ORDER BY 'derived.tick_state'.'TickIndex' ${
                invertedOrder ? 'ASC' : 'DESC'
              }
            `).append(`--sql
              -- add pagination
              LIMIT ${pagination.limit + 1}
              OFFSET ${pagination.offset}
            `)
        )) ?? []
      : [];

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
    shape: ['tick_index', 'reserves'],
    data: data.map(
      // invert the indexes depending on which price ratio was asked for
      // tick_index is tickIndexBtoA
      // return reserves as a number (of smaller precision to save bytes)
      invertedOrder
        ? (row): DataRow => {
            return [
              -row['tickIndex'],
              Number(new BigNumber(row['reserves']).toPrecision(3)),
            ];
          }
        : (row): DataRow => {
            return [
              row['tickIndex'],
              Number(new BigNumber(row['reserves']).toPrecision(3)),
            ];
          }
    ),
    pagination: {
      next_key: nextKey,
    },
  };
}
