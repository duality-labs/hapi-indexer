import sql from 'sql-template-tag';

import { Route } from '../../../types';
import { getCachedResponse } from '../../../utils/cache-query';
import { inMs, minutes } from '../../../utils/units';
import { selectVaultConfigs } from '../../../common-table-expressions/vaultConfigs';

export interface Request {
  params: { address: string };
  query: {
    limit?: string;
  };
}
export interface Response {
  contract_address: string;
  user_fraction: number;
}
const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/user/:address/shares',
  handler: async (request, abortSignal, previousResponse) => {
    const sourceTableHeight = await getCachedResponse<{ height: string }>(
      sql`
        SELECT max("height") AS "height"
        FROM spacebox."raw_block_results"
      `,
      abortSignal
    );

    const currentHeights = await Promise.all([
      getCachedResponse<{ height: string }>(
        sql`
            SELECT max("height") AS "height"
            FROM spacebox."dex_vaults_config_tx_event"
          `,
        abortSignal
      ),
      getCachedResponse<{ height: string }>(
        sql`
            SELECT max("height") AS "height"
            FROM spacebox."dex_vaults_shares"
          `,
        abortSignal
      ),
    ]);

    const currentHeight = Math.max(
      ...currentHeights.map(
        (response) => Number(response.data.at(0)?.height) || 0
      )
    );

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        WITH
          contract_shares as (
            SELECT
              max(bank."height") as "height",
              config."contract_address" as "contract_address",
              config."denom" as "denom",
              sumIf(bank."balance", bank."address" = ${
                request.params.address
              }) as "user_shares",
              sum(bank."balance") as "total_shares"
            FROM (${selectVaultConfigs}) as config
            JOIN spacebox."bank_transfer_state" as bank
              ON config."denom" = bank."denom"
            GROUP BY config."contract_address", config."denom"
          )
        SELECT
          "height",
          "contract_address",
          "user_shares" / "total_shares" as "user_fraction"
        FROM contract_shares
        WHERE
          "user_shares" > 0
          ${
            previousResponse
              ? // if this is an incremental update, get changes since known height
                sql`
                  AND "height" > ${Number(previousResponse?.height) || 0}
                `
              : // else return all
                sql``
          }
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
          Math.max(0, ...data.map((row) => Number(row.height) || 0)) || 0,
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => name !== 'height')
          );
        },
        cacheTime: 1 * minutes * inMs,
        cacheVersion: currentHeight,
      }
    );
  },
};
