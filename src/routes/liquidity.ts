import { Request } from '@hapi/hapi';
import sql from 'sql-template-tag';

import { handleResponse } from '../utils/response';
import { getCachedResponse } from '../utils/cache-query';
import { hours, inMs } from '../utils/units';

export const route = {
  method: 'GET',
  path: '/liquidity/{denomA}/{denomB}',
  handler: handleResponse(
    async (
      request: Request<{
        Params: { denomA: string; denomB: string };
      }>,
      abortSignal: AbortSignal
    ) => {
      const [denom0, denom1] = [
        request.params.denomA,
        request.params.denomB,
      ].sort();

      const sourceTableHeight = await getCachedResponse<{ height: string }>(
        sql`
          SELECT max("height") AS "height"
          FROM spacebox."raw_block_results"
        `,
        abortSignal
      );

      const currentHeight = await getCachedResponse<{ height: string }>(
        sql`
          SELECT max("height") AS "height"
          FROM spacebox."dex_message_event_tick_update"
          WHERE "TokenZero" = ${denom0}
            AND "TokenOne" = ${denom1}
        `,
        abortSignal
      );

      return await getCachedResponse<
        { token: boolean; index: string; reserves: string; height: string },
        { index: string; reserves_0?: string; reserves_1?: string }
      >(
        sql`
        SELECT
          "height",
          "TokenIn" = "TokenOne" as "token",
          "TickIndex" as "index",
          "Reserves" as "reserves"
        FROM (${selectLatestTickState})
        WHERE "TokenZero" = ${denom0}
          AND "TokenOne" = ${denom1}
          -- ignore zero reserve pools that are older than a few blocks
          -- this should remove most non-relevant zero reserve data rows
          AND (not("ReservesZero") OR "timestamp" > addSeconds(NOW(), -30))
      `,
        abortSignal,
        {
          heartbeat: Number(sourceTableHeight.data.at(0)?.height),
          getRow: ({ token, index, reserves }) => ({
            index,
            [token ? 'reserves_1' : 'reserves_0']: reserves,
          }),
          getHeight: (data) =>
            Number(
              data.reduce(
                (acc, row) => Math.max(acc, Number(row.height) || 0),
                0
              )
            ),
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
    }
  ),
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
