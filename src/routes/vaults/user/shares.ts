import sql from 'sql-template-tag';

import { Route } from '../../../types';
import { getCachedResponse } from '../../../utils/cache-query';
import { inMs, minutes, toUnixTime } from '../../../utils/units';

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
    const sources = await Promise.all([
      getCachedResponse<{ height: string; time: string }>(
        sql`
          SELECT max("height") AS "height", max("timestamp") AS "time"
          FROM spacebox.dex_vaults_events_dex_deposit_state
        `,
        abortSignal
      ),
      getCachedResponse<{ height: string; time: string }>(
        sql`
          SELECT max("height") AS "height", max("timestamp") AS "time"
          FROM spacebox.dex_vaults_shares_state
        `,
        abortSignal
      ),
    ]);

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        WITH
          bank_transfer as (
            SELECT
              "timestamp",
              "height",
              "block_part_index",
              "tx_index",
              "event_index",
              "coins_index",
              "sort_key",
              "address",
              "denom",
              "sign",
              "amount"
            FROM spacebox.bank_transfer
            WHERE "address" = ${request.params.address}
              AND "denom" IN (SELECT "denom" FROM spacebox.dex_vaults_config_state)
          ),
          deduplicated_bank_transfer AS (
            SELECT
              any("timestamp") as "timestamp",
              "height",
              any("denom") as "denom",
              any("sign") as "sign",
              any("amount") as "amount"
            FROM bank_transfer
            GROUP BY
              "height",
              "block_part_index",
              "tx_index",
              "event_index",
              "coins_index"
          ),
          deduplicated_bank_user_amount as (
            SELECT
              "denom",
              sum("amount" * "sign") as "amount",
              count() > 0 as "had_amount",
              countIf("timestamp" >= subtractMonths(toStartOfDay(now()), 1)) > 0 as "had_amount_recently"
            FROM deduplicated_bank_transfer
            GROUP BY "denom"
          )
        SELECT
          greatest(v."height", s."height") as "height",
          greatest(v."timestamp", s."timestamp") as "time",
          c."contract_address" as "contract_address",
          b."amount" as "user_shares",
          s."shares" as "total_shares",
          "user_shares" / "total_shares" as "user_fraction",
          "user_fraction" * toFloat64(v."token_0_balance") as "user_token_0_amount",
          "user_fraction" * toFloat64(v."token_1_balance") as "user_token_1_amount",
          "user_fraction" * toFloat64(v."token_0_value") as "user_token_0_value",
          "user_fraction" * toFloat64(v."token_1_value") as "user_token_1_value"
        FROM deduplicated_bank_user_amount as b
        ANY LEFT JOIN spacebox.dex_vaults_config_state as c
          ON (b."denom" = c."denom")
        ANY LEFT JOIN spacebox.dex_vaults_shares_state as s
          ON (c."contract_address" = s."contract_address")
        ANY LEFT JOIN spacebox.dex_vaults_events_dex_deposit_state as v
          ON (c."contract_address" = v."contract_address")
        WHERE
          -- filter to "if user has or has recently held shares on this vault"
          (b."amount" > 0 OR b."had_amount_recently" > 0)
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
        heartbeat: Math.max(
          ...sources.map((r) => Number(r.data.at(0)?.height) || 0)
        ),
        timestamp: sources
          .slice()
          .sort(
            (a, b) =>
              toUnixTime(a.data.at(0)?.time) - toUnixTime(b.data.at(0)?.time)
          )
          .at(-1)
          ?.data.at(0)?.time,
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
        cacheVersion: sources.reduce(
          (acc, r) => acc + (Number(r.data.at(0)?.height) || 0),
          0
        ),
      }
    );
  },
};
