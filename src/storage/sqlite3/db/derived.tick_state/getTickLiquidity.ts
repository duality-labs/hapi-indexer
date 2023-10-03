import BigNumber from 'bignumber.js';
import sql from 'sql-template-strings';
import { CachePolicyOptions, Request } from '@hapi/hapi';
import { Policy } from '@hapi/catbox';

import db from '../db';
import getHeight from '../block/getHeight';
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

interface TickStateTableRow {
  tickIndex: number;
  reserves: string;
}
async function getTickState(token0: string, token1: string, token: string) {
  const reverseDirection = token1 === token;
  return await db
    .all<TickStateTableRow[]>(
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
            'dex.pairs'.'token0' = ${token0} AND
            'dex.pairs'.'token1' = ${token1}
          )
        ) AND
        'derived.tick_state'.'related.dex.token' = (
          SELECT
            'dex.tokens'.'id'
          FROM
            'dex.tokens'
          WHERE (
            'dex.tokens'.'Token' = ${token}
          )
        ) AND
        'derived.tick_state'.'Reserves' != '0'
      )
    `.append(`--sql
      -- order by tick side
      -- order by most important (middle) ticks first
      ORDER BY 'derived.tick_state'.'TickIndex' ${
        reverseDirection ? 'ASC' : 'DESC'
      }
    `)
    )
    // transform data for the tickIndexes to be in terms of A/B.
    .then((data) => {
      return data.map((row): DataRow => {
        return [
          // invert the indexes depending on which price ratio was asked for
          // so the indexes are in terms of token/otherToken
          reverseDirection ? -row['tickIndex'] : row['tickIndex'],
          // return reserves as a number (of smaller precision to save bytes)
          Number(new BigNumber(row['reserves']).toPrecision(3)),
        ];
      });
    });
}

export type HeightedTickState = [number, DataRow[], DataRow[]];

export async function getHeightedTickState(token0: string, token1: string) {
  return new Promise<HeightedTickState>((resolve, reject) => {
    db.getDatabaseInstance().parallelize(() => {
      Promise.all([
        // get chain height
        getHeight(),
        // get tokenA liquidity
        getTickState(token0, token1, token0),
        // get tokenB liquidity
        getTickState(token0, token1, token1),
      ])
        .then((promises) => resolve(promises))
        .catch((error) => reject(error));
    });
  });
}

export function paginateTickLiquidity(
  data: DataRow[],
  query: PaginatedRequestQuery = {}
): TickLiquidityResponse {
  // collect pagination keys into a pagination object
  const [{ offset, limit }, getNextKey] = getPaginationFromQuery(query);

  const page = data.slice(offset, offset + limit);
  // if result includes an item from the next page then remove it
  // and generate a next key to represent the next page of data
  const nextKey = data.length > offset + limit ? getNextKey(limit) : null;

  return {
    shape: ['tick_index', 'reserves'],
    data: page,
    pagination: {
      next_key: nextKey,
    },
  };
}

type LiquidityCache = Policy<
  HeightedTickState,
  CachePolicyOptions<HeightedTickState>
>;
let liquidityCache: LiquidityCache;
function getLiquidityCache(server: Request['server']) {
  if (!liquidityCache) {
    liquidityCache = server.cache<HeightedTickState>({
      segment: '/liquidity/token/tokenA/tokenB',
      expiresIn: 1000 * 60, // allow for a few block heights
      generateFunc: async (id) => {
        const [token0, token1] = `${id}`.split('|');
        if (!token0 || !token1) {
          throw new Error('Tokens not specified');
        }
        const ticksState = await getHeightedTickState(token0, token1);
        const [height] = ticksState;
        // set cache entry with this height for future lookups
        liquidityCache.set([token0, token1, height].join('|'), ticksState);
        // return this cache set
        return ticksState;
      },
      generateTimeout: 1000 * 20,
    });
  }
  return liquidityCache;
}

export async function getHeightedTokenPairLiquidity(
  server: Request['server'],
  tokenA: string,
  tokenB: string,
  requestedHeight: string | number | undefined
): Promise<HeightedTickState | null> {
  const liquidityCache = getLiquidityCache(server);
  const invertedOrder = await hasInvertedOrder(tokenA, tokenB);
  const token0 = invertedOrder ? tokenB : tokenA;
  const token1 = invertedOrder ? tokenA : tokenB;

  // get liquidity state through cache
  const response = await liquidityCache.get(
    [token0, token1, requestedHeight].filter(Boolean).join('|')
  );
  // return the response data in the correct order
  if (response) {
    const [height, tickState0, tickState1] = Array.isArray(response)
      ? response
      : response.value;
    return invertedOrder
      ? [height, tickState1, tickState0]
      : [height, tickState0, tickState1];
  } else {
    return null;
  }
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
