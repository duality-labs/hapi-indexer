import sql from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import { hours, inMs } from '../../utils/units';

interface Request {
  params: Record<string, never>;
}
interface Response {
  created_at_height: string;
  updated_at_height: string;
  created_at: string;
  updated_at: string;
  token_0: string;
  token_1: string;
}

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/dex/pairs',
  handler: async (_, abortSignal, previousResponse) => {
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
        `,
      abortSignal
    );

    const pairs = await getCachedResponse<Response>(
      sql`
        SELECT
          "TokenZero" AS "token_0",
          "TokenOne" AS "token_1",
          argMin("height", "sort_key") AS "created_at_height",
          argMax("height", "sort_key") AS "updated_at_height",
          argMin("timestamp", "sort_key") AS "created_at",
          argMax("timestamp", "sort_key") AS "updated_at"
        FROM spacebox."dex_message_event_tick_update"
        -- group reserves from all tick index fees and tranche keys together
        GROUP BY
          "TokenZero",
          "TokenOne"
        -- order chronologically for stability?
        ORDER BY "created_at_height" ASC
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        getHeight: (data) =>
          Math.max(0, ...data.map((row) => Number(row.updated_at_height) || 0)),
        getMetadata: (metadata) => {
          return (
            metadata
              // add type and units
              ?.map((row) =>
                ['token_0', 'token_1'].includes(row.name)
                  ? { ...row, type: 'String' }
                  : row
              )
              // add time units, convert tick index units
              ?.map((row) =>
                ['created_at', 'updated_at'].includes(row.name)
                  ? { ...row, units: 'YYYY-MM-DD hh:mm:ss UTC' }
                  : row
              )
          );
        },
        cacheTime: 1 * hours * inMs,
        cacheVersion: Number(currentHeight.data.at(0)?.height) ?? undefined,
      }
    );

    // filter out non-updates from response
    if (previousResponse) {
      return {
        ...pairs,
        data: pairs.data.filter(
          (row) => Number(row.updated_at_height) > previousResponse.height
        ),
      };
    }
    return pairs;
  },
};
