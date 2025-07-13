import sql from 'sql-template-tag';

import { Route } from '../../../types';
import { getCachedResponse } from '../../../utils/cache-query';
import { inMs, minutes } from '../../../utils/units';

export interface Request {
  params: { address: string };
  query: {
    limit?: string;
  };
}
export interface Response {
  contract_address: string;
  user_shares: string;
  total_shares: string;
  user_fraction: number;
  tvl: number;
  tvl_user_fraction: number;
}
const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/user/:address/shares',
  handler: async (request, abortSignal, previousResponse) => {
    const source = await getCachedResponse<{ height: string; time: string }>(
      sql`
        SELECT max("height") AS "height", max("timestamp") AS "time"
        FROM spacebox.dex_vaults_events_dex_deposit_state
      `,
      abortSignal
    );

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        WITH
          -- query is much faster when this is pre-filtered
          -- note: I know it looks like an unnecessary duplicate, but it is not
          filtered_bank_transfer_state as (
            SELECT * FROM spacebox.bank_transfer_state
            WHERE "denom" IN (
              SELECT "denom" FROM spacebox.dex_vaults_config_state
            )
          ),
          contract_shares as (
            SELECT
              max(bank."height") as "height",
              max(bank."timestamp") as "timestamp",
              config."contract_address" as "contract_address",
              config."denom" as "denom",
              sumIf(bank."balance", bank."address" = ${
                request.params.address
              }) as "user_shares",
              sum(bank."balance") as "total_shares"
            FROM spacebox.dex_vaults_config_state as config
            LEFT JOIN filtered_bank_transfer_state as bank
              ON config."denom" = bank."denom"
            GROUP BY config."contract_address", config."denom"
          )
        SELECT
          v."height" as "height",
          v."timestamp" as "time",
          s."contract_address" as "contract_address",
          s."user_shares" as "user_shares",
          s."total_shares" as "total_shares",
          s."user_shares" / s."total_shares" as "user_fraction",
          v."tvl" as "tvl",
          v."tvl" * "user_fraction" as "tvl_user_fraction"
        FROM contract_shares as s
        ANY LEFT JOIN spacebox.dex_vaults_events_dex_deposit_state as v
          ON (s."contract_address" = v."contract_address")
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
        heartbeat: Number(source.data.at(0)?.height),
        timestamp: source.data.at(0)?.time,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        getRow: ({ height, ...rest }) => rest,
        getHeight: (data) =>
          Math.max(0, ...data.map((row) => Number(row.height) || 0)) || 0,
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => name !== 'height')
              // add time units
              ?.map((row) =>
                row.name === 'time'
                  ? { ...row, units: 'YYYY-MM-DD hh:mm:ss UTC' }
                  : row
              )
              // add value units
              ?.map((row) =>
                row.name.startsWith('tvl') ? { ...row, units: 'USD' } : row
              )
          );
        },
        cacheTime: 1 * minutes * inMs,
        cacheVersion: Number(source.data.at(0)?.height),
      }
    );
  },
};
