import sql from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import { hours, inMs } from '../../utils/units';

interface Request {
  params: { denomA: string; denomB: string };
  query: {
    to_height?: string;
  };
}
interface Response {
  index: string;
  reserves_0?: string;
  reserves_1?: string;
}

const threshold = 10;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/dex/liquidity/:denomA/:denomB',
  handler: async (request, abortSignal, previousResponse) => {
    const [denom0, denom1] = [
      request.params.denomA,
      request.params.denomB,
    ].sort();

    const [sourceTableHeight, sourceTableTime, currentHeight] =
      await Promise.all([
        getCachedResponse<{ height: string }>(
          sql`
            SELECT max("height") AS "height"
            FROM spacebox."raw_block_results"
          `,
          abortSignal
        ),
        getCachedResponse<{ time: string }>(
          sql`
            SELECT max("updated_at") AS "time"
            FROM spacebox."raw_block_results_order"
          `,
          abortSignal
        ),
        getCachedResponse<{ height: string }>(
          sql`
            SELECT max("height") AS "height"
            FROM spacebox."dex_message_event_tick_update"
            WHERE "TokenZero" = ${denom0}
              AND "TokenOne" = ${denom1}
          `,
          abortSignal
        ),
      ]);

    // alow querying tick state up to a specific height
    const toHeight = Number(request.query.to_height) || 0;

    return await getCachedResponse<
      { token: boolean; index: string; reserves: string; max_height: string },
      { index: string; reserves_0?: string; reserves_1?: string }
    >(
      sql`
        SELECT
          max("height") as "max_height",
          "TokenIn" = "TokenOne" as "token",
          "TickIndex" as "index",
          -- this is specifically for incremental updates to not show dust rows
          -- when they appear (initial request will have all "if" as true here)
          sumIf("Reserves", "Reserves" >= ${threshold}) as "reserves"
        FROM (${
          toHeight > 0
            ? selectLatestTickStateAtHeight(toHeight)
            : selectLatestTickState
        })
        WHERE "TokenZero" = ${denom0}
          AND "TokenOne" = ${denom1}
          AND ${
            previousResponse
              ? // if this is an incremental update, get changes since known height
                // and check possibly skipped blocks within the last 100 blocks
                sql`"height" >= (
                  SELECT min(height)
                  FROM spacebox.raw_block_results_order
                  WHERE updated_at >= toDateTime(${previousResponse.timestamp})
                )`
              : // if this is an initial request, ignore unhelpful zero reserve rows
                sql`"Reserves" >= ${threshold}`
          }
        -- group reserves from all tick index fees and tranche keys together
        GROUP BY
          "TokenZero",
          "TokenOne",
          "TokenIn",
          "TickIndex"
        -- important rows first (closest to current price from token direction)
        ORDER BY "index" ASC
      `,
      abortSignal,
      {
        timestamp: sourceTableTime.data.at(0)?.time,
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        getRow: ({ token, index, reserves }) => ({
          index,
          [token ? 'reserves_1' : 'reserves_0']: reserves,
        }),
        getHeight: (data) =>
          Math.max(0, ...data.map((row) => Number(row.max_height) || 0)),
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => ['index', 'reserves'].includes(name))
              // add names and units
              ?.flatMap((row) =>
                row.name === 'reserves'
                  ? [
                      { ...row, name: 'reserves_0', units: denom0 },
                      { ...row, name: 'reserves_1', units: denom1 },
                    ]
                  : row
              )
          );
        },
        cacheTime: 1 * hours * inMs,
        cacheVersion: Number(currentHeight.data.at(0)?.height) ?? undefined,
      }
    );
  },
};

// note: it is important to user argMax() to query the latest version number
//       because the table is likely to have multiple version rows at query time
//       this is an inherent part of ClickHouse MergeTree engines
// @see: https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree#query-time-de-duplication--final
const selectLatestTickState = sql`
  SELECT
    argMax("timestamp", "version") as "timestamp",
    argMax("height", "version") as "height",
    "TokenZero",
    "TokenOne",
    "TokenIn",
    "TickIndex",
    "Fee",
    "TrancheKey",
    argMax("Reserves", "version") as "Reserves",
    argMax("ReservesZero", "version") as "ReservesZero"
  FROM spacebox.dex_message_event_tick_state
  GROUP BY
    "TokenZero",
    "TokenOne",
    "TokenIn",
    "TickIndex",
    "Fee",
    "TrancheKey"
`;

const selectLatestTickStateAtHeight = (height: number) => sql`
  WITH
    -- note: taken from https://github.com/neutron-org/spacebox-indexer/blob/2c832537997a2648446701b532ce3e2ca55fdc01/migrations/clickhouse/000020_dex_message_event_tick_update.up.sql#L275-L280
    (tu."event_index"        * toUInt256(1))
    + (tu."tx_index"         * toUInt256(4294967296))              -- + shift by 32 event_index bits (2^32)
    + (tu."block_part_index" * toUInt256(18446744073709551616))    -- + shift by 32 tx_index bits (2^64)
    + (tu."height"           * toUInt256(4722366482869645213696))  -- + shift by 8 part_index bits (2^72)
    AS "version"
  SELECT
    argMax("timestamp", "version") as "timestamp",
    argMax("height", "version") as "height",
    "TokenZero",
    "TokenOne",
    "TokenIn",
    "TickIndex",
    "Fee",
    "TrancheKey",
    argMax("Reserves", "version") as "Reserves",
    "Reserves" = 0 as "ReservesZero"
  FROM spacebox.dex_message_event_tick_update as tu
  WHERE tu."height" <= ${height}
  GROUP BY
    "TokenZero",
    "TokenOne",
    "TokenIn",
    "TickIndex",
    "Fee",
    "TrancheKey"
`;
