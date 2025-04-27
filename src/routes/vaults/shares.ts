import sql from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import { hours, inMs } from '../../utils/units';

export interface Request {
  params: { contract: string };
  query: {
    limit?: string;
  };
}
export interface Response {
  time: string;
}
const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/shares/{contract}',
  handler: async (request, abortSignal, previousResponse) => {
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
          FROM spacebox."dex_vaults_shares"
        `,
      abortSignal
    );

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        WITH
          dex_vaults_shares_updates as (
            SELECT
              "height",
              "sort_key",
              "total_shares"
            FROM spacebox."dex_vaults_shares"
            WHERE "contract_address" = ${request.params.contract}
            ${
              previousResponse
                ? // if this is an incremental update, get changes since known height
                  sql`
                    AND "height" > ${previousResponse.height}
                  `
                : // else return all
                  sql``
            }
            -- default sort reverse chronologically
            ORDER BY "sort_key" DESC
          ),
          dex_vaults_shares_updates_grouped_to_height as (
            SELECT
              "height",
              argMax("total_shares", "sort_key") AS "total_shares"
            FROM dex_vaults_shares_updates
            GROUP BY "height"
          )
        SELECT
          "height",
          "total_shares"
        FROM dex_vaults_shares_updates_grouped_to_height
        -- default sort reverse chronologically
        ORDER BY "height" DESC
        -- cap limit to max, set default if not well defined
        LIMIT ${Math.min(Number(request.query.limit), MAX_ROWS) || DEFAULT_ROWS}
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        getRow: ({ height, ...rest }) => rest,
        getHeight: (data) =>
          Number(data.find((row) => Number(row.height) > 0)?.height),
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => name !== 'height')
          );
        },
        cacheTime: 1 * hours * inMs,
        cacheVersion: Number(currentHeight?.data.at(0)?.height) || 0,
      }
    );
  },
};
