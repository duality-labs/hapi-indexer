import sql from 'sql-template-tag';

import { Route } from '../../../types';
import { getCachedResponse } from '../../../utils/cache-query';
import { WithFillTimePeriod } from '../../../utils/units';
import { endTime, getAllTimes, getEndTimeCacheConfig } from '../_common';
import timeRangeTimeseries from '../../../common-table-expressions/timeRangeTimeseries';

export interface Request {
  params: { contract: string; address: string };
  query: {
    from?: string;
    to?: string;
    periods?: string;
    period?: WithFillTimePeriod;
    limit?: string;
  };
}
export interface Response {
  time: string;
  time_end: string;
  vault_value_0: number;
  vault_value_1: number;
  hold_value_0: number;
  hold_value_1: number;
}

const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/:contract/user/:address/pnl-v2',
  handler: async (request, abortSignal, previousResponse) => {
    // cache to specific end time
    const cacheConfig = await getEndTimeCacheConfig(abortSignal);

    const sourceTableHeight = await getCachedResponse<{ height: string }>(
      sql`
        SELECT max("height") AS "height"
        FROM spacebox."raw_block_results"
        WHERE "timestamp" <= ${endTime}
      `,
      abortSignal,
      cacheConfig
    );

    // get query times
    const time = await getAllTimes(
      {
        ...request.query,
        fromPrevious: previousResponse?.data.at(0)?.time,
      },
      abortSignal,
      cacheConfig
    );

    if (!time) {
      throw new Error('Invalid start/end times');
    }

    // get timeseries data
    return await getCachedResponse<
      Response & { height: number; apr_percentage: number },
      Response
    >(
      sql`
        WITH
          ${request.params.contract} as "_contract_address",
          vault_config AS (
            SELECT * FROM spacebox.dex_vaults_config_state
            WHERE "contract_address" = "_contract_address"
            ORDER BY "updated_at" DESC
            LIMIT 1
          ),
          time_range AS (${timeRangeTimeseries({
            ...time,
            contractAddress: request.params.contract,
          })}),
          price_first_row AS (
            SELECT
              "contract_address",
              "token_0_price",
              "token_1_price"
            FROM spacebox.price_by_vault_denom_first_state
            WHERE "contract_address" = "_contract_address"
            LIMIT 1
          ),
          balance_user_share_txs AS (
            WITH deduplicated_shares AS (
              SELECT
                argMax(s."height", "timestamp_version") as "height",
                argMax(s."timestamp", "timestamp_version") as "timestamp",
                argMax(s."action", "timestamp_version") as "action",
                argMax(s."contract_address", "timestamp_version") as "contract_address",
                argMax(s."creator", "timestamp_version") as "creator",
                argMax(s."hold_equivalent_0", "timestamp_version") as "hold_equivalent_0",
                argMax(s."hold_equivalent_1", "timestamp_version") as "hold_equivalent_1",
                argMax(s."shares_in", "timestamp_version") as "shares_in",
                argMax(s."shares_out", "timestamp_version") as "shares_out",
                max(s."sort_key") as "sort_key"
              FROM (
                SELECT *, "timestamp_version", "sort_key"
                FROM spacebox.dex_vaults_shares_valued
                WHERE "contract_address" = "_contract_address"
              ) as s
              GROUP BY s."height", s."block_part_index", s."tx_index", s."event_index"
            )
            SELECT
              "height",
              "timestamp",
              "sort_key",
              "action",
              "contract_address",
              "shares_in",
              "shares_out",
              ${
                request.params.address
                  ? // fetch user's share of vault
                    sql`
                  "creator" = ${request.params.address} as "is_creator",
                  "hold_equivalent_0",
                  "hold_equivalent_1",
                  sumIf("shares_in" - "shares_out", "is_creator") OVER cumulative_events as "user_shares",
                  sum("shares_in" - "shares_out") OVER cumulative_events as "total_shares"
                `
                  : // use all of vault for calculations
                    sql`
                  1 as "is_creator",
                  "hold_equivalent_0",
                  "hold_equivalent_1",
                  "total_shares" as "user_shares",
                  sum("shares_in" - "shares_out") OVER cumulative_events as "total_shares"
                `
              }
            FROM deduplicated_shares
            WINDOW cumulative_events AS (
              -- partition sums to each pool
              PARTITION BY "contract_address"
              ORDER BY "sort_key" ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )
            ORDER BY "sort_key" ASC
          ),
          balance_user_share_transfers AS (
            WITH
              bank_transfers AS (
                SELECT
                  "height",
                  "timestamp",
                  (SELECT "contract_address" FROM vault_config) as "contract_address",
                  "type",
                  if("type" = 'coin_received', "amount", 0) as "shares_in",
                  if("type" = 'coin_spent', "amount", 0) as "shares_out",
                  "sort_key"
                FROM spacebox.bank_transfer_by_address_then_denom
                WHERE "denom" = (SELECT "denom" FROM vault_config)
                  AND "address" = ${request.params.address}
                ORDER BY "sort_key" ASC
              ),
              if(p."price_timestamp" > 0, p."price_0", 0) as "token_price_0",
              if(p."price_timestamp" > 0, p."price_1", 0) as "token_price_1",
              p."total_shares" as "total_shares",
              p."value_open" as "total_shares_value",
              p."price_timestamp" as "price_timestamp",
              if("total_shares" > 0, toFloat64("shares_in" - "shares_out") * "total_shares_value" / "total_shares", 0) as "shares_value"
            SELECT
              "height",
              "timestamp",
              "sort_key",
              if("type" = 'coin_received', 'deposit', 'withdrawal') as "action",
              "contract_address",
              "shares_in",
              "shares_out",
              1 as "is_creator",
              if("token_price_0" > 0, "shares_value" / 2 / "token_price_0", 0) as "hold_equivalent_0",
              if("token_price_1" > 0, "shares_value" / 2 / "token_price_1", 0) as "hold_equivalent_1",
              sum("shares_in" - "shares_out") OVER cumulative_events as "user_shares",
              "total_shares"
            FROM bank_transfers as b
            ASOF LEFT JOIN spacebox.dex_vaults_shares_valued as p
                ON (b."contract_address" = p."contract_address")
                AND b."timestamp" >= p."timestamp"
            WINDOW cumulative_events AS (
              -- partition sums to each pool
              PARTITION BY "contract_address"
              ORDER BY "sort_key" ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )
          ),
          balance_user_share as (
            WITH balance_union AS (
              -- get other user share changes
              SELECT * FROM balance_user_share_txs
              WHERE "is_creator" = 0
              -- add this user share changes
              UNION ALL
              SELECT * FROM balance_user_share_transfers
            )
            SELECT
              "height",
              "timestamp",
              "sort_key",
              "action",
              "contract_address",
              "shares_in",
              "shares_out",
              "is_creator",
              "hold_equivalent_0",
              "hold_equivalent_1",
              -- overwrite the user_shares from more accurate transfers table
              sumIf("shares_in" - "shares_out", "is_creator") OVER cumulative_events as "user_shares",
              "total_shares"
            FROM balance_union
            WINDOW cumulative_events AS (
              -- partition sums to each pool
              PARTITION BY "contract_address"
              ORDER BY "sort_key" ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )
            ORDER BY "sort_key" ASC
          ),
          balance_increase_rows AS (
            SELECT *, "sort_key"
            FROM balance_user_share
            WHERE "action" = 'deposit'
          ),
          balance_decrease_rows AS (
            SELECT *, "sort_key"
            FROM balance_user_share
            WHERE "action" = 'withdrawal'
          ),
          balance_hold_amount AS (
            WITH
              hold_adjustments_union AS (
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  "contract_address",
                  if ("is_creator" = 1, "hold_equivalent_0", 0) as "hold_amount_increase_0",
                  if ("is_creator" = 1, "hold_equivalent_1", 0) as "hold_amount_increase_1",
                  "user_shares",
                  "total_shares",
                  0 as "share_fraction_reduction"
                FROM balance_increase_rows
                UNION ALL
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  "contract_address",
                  0 as "hold_amount_increase_0",
                  0 as "hold_amount_increase_1",
                  "user_shares",
                  "total_shares",
                  if (
                    "is_creator" = 1 AND ("shares_out" > 0 OR "user_shares" > 0),
                    toFloat64("shares_out" / ("shares_out" + "user_shares")),
                    0
                  ) as "share_fraction_reduction"
                FROM balance_decrease_rows
              ),
              -- ensure there are no duplicate events for each event index before SUM
              hold_adjustments_by_event AS (
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  anyLast("contract_address") as "contract_address",
                  anyLast("hold_amount_increase_0") as "hold_amount_increase_0",
                  anyLast("hold_amount_increase_1") as "hold_amount_increase_1",
                  anyLast("user_shares") as "user_shares",
                  anyLast("total_shares") as "total_shares",
                  anyLast(1 - "share_fraction_reduction") as "share_fraction_multiplier"
                FROM hold_adjustments_union
                GROUP BY "sort_key", "height", "timestamp"
                ORDER BY "sort_key" ASC
              ),
              hold_adjustments_with_sequence_marker AS (
                SELECT
                  *,
                  sum(if("share_fraction_multiplier" > 0, 0, 1)) OVER  (
                    ORDER BY "sort_key"
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  ) as "marker"
                FROM hold_adjustments_by_event
              ),
              hold_amount_by_event AS (
                WITH
                  /* ---- 1. build the running product (P_i) ---- */
                  prod AS (
                    SELECT
                      "timestamp",
                      "height",
                      "marker",
                      "sort_key",
                      "contract_address",
                      "hold_amount_increase_0",
                      "hold_amount_increase_1",
                      "user_shares",
                      "total_shares",
                      /* prefix-product P_i  =  exp( Σ log(mult) ) */
                      if (
                        "share_fraction_multiplier" > 0,
                        exp(
                          sumIf(
                            log( toFloat64("share_fraction_multiplier") ),
                            "share_fraction_multiplier" > 0
                          ) OVER (
                            PARTITION BY "marker"
                            ORDER BY "sort_key"
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                          )
                        ),
                        0
                      ) AS "P_i"
                    FROM hold_adjustments_with_sequence_marker
                  ),
                  /* ---- 2. derive scaled increases ---- */
                  calc AS (
                    SELECT
                      "timestamp",
                      "height",
                      "marker",
                      "sort_key",
                      "contract_address",
                      "user_shares",
                      "total_shares",
                      "P_i",
                      /* scaled add_k / P */
                      if ("P_i" > 0, toFloat64("hold_amount_increase_0") / "P_i", 0) AS "scaled_hold_amount_increase_0",
                      if ("P_i" > 0, toFloat64("hold_amount_increase_1") / "P_i", 0) AS "scaled_hold_amount_increase_1"
                    FROM prod
                  )
                  /* ---- 3. get running sum, final total ---- */
                SELECT
                  "timestamp",
                  "height",
                  "marker",
                  "sort_key",
                  "contract_address",
                  "user_shares",
                  "total_shares",
                  /* running sum of scaled_add = Σ add_k / P */
                  /* final cumulative total is prefix-product * running-sum */
                  "P_i" * sum("scaled_hold_amount_increase_0") OVER cumulative_events AS "hold_amount_0",
                  "P_i" * sum("scaled_hold_amount_increase_1") OVER cumulative_events AS "hold_amount_1"
                FROM calc
                WINDOW cumulative_events AS (
                  PARTITION BY "marker"
                  ORDER BY "sort_key" ASC
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                )
                ORDER BY "sort_key"
              )
              -- get the last value at each height
              SELECT *
              FROM hold_amount_by_event
          ),
          timeseries AS (
            WITH
              if(
                p."timestamp" > 0,
                p."token_0_price",
                (SELECT "token_0_price" FROM price_first_row)
              ) as "token_price_0",
              if(
                p."timestamp" > 0,
                p."token_1_price",
                (SELECT "token_1_price" FROM price_first_row)
              ) as "token_price_1",
              user."hold_amount_0" as "hold_amount_0",
              user."hold_amount_1" as "hold_amount_1",
              -- TODO: fill in the times where the vault has removed shares from the dex (but kept them in wallet)
              --       by ensuring that the "token_0/1_balance" field is the correct "in wallet" amount
              vault."token_0_balance" as "vault_amount_0",
              vault."token_1_balance" as "vault_amount_1",
              if (user."total_shares" > 0, user."user_shares" / user."total_shares", 0) as "user_fraction_of_tvl"
            SELECT
              greatest(vault."height", user."height") as "height",
              t."time_period_start" as "time",
              t."time_period_end" as "time_end",
              vault."contract_address" as "contract_address",
              toFloat64("vault_amount_0") * "user_fraction_of_tvl" as "user_amount_0",
              toFloat64("vault_amount_1") * "user_fraction_of_tvl" as "user_amount_1",
              "token_price_0" * toFloat64("hold_amount_0") as "hold_value_0",
              "token_price_1" * toFloat64("hold_amount_1") as "hold_value_1",
              "token_price_0" * toFloat64("vault_amount_0") * "user_fraction_of_tvl" as "vault_value_0",
              "token_price_1" * toFloat64("vault_amount_1") * "user_fraction_of_tvl" as "vault_value_1"
            FROM time_range as t
            -- get most recent price before the end of the time period
            ASOF JOIN spacebox.price_by_vault_denom_by_minute as p
              ON (p."contract_address" = t."contract_address")
              AND p."timestamp" < t."time_period_end"
            -- get most recent user balances before the end of the time period
            ASOF JOIN balance_hold_amount as user
              ON (user."contract_address" = t."contract_address")
              AND user."timestamp" < t."time_period_end"
            -- get most recent vault balance before the end of the time period
            ASOF JOIN (
                SELECT
                  "height",
                  "timestamp",
                  "contract_address",
                  "token_0_balance",
                  "token_1_balance",
                  "sort_key"
                FROM spacebox.dex_vaults_events_dex_deposit
                WHERE "contract_address" = "_contract_address"
                  -- TODO: when calculating vault balances correctly allow
                  --       dex_withdrawals to set dex balance to zero and read
                  --       the account token0/1 tokens from the bank module
              ) as vault
              ON (vault."contract_address" = t."contract_address")
              AND vault."timestamp" < t."time_period_end"
          )
        SELECT
          time_range."time_period_start" as "time",
          time_range."time_period_end" as "time_end",
          "height",
          -- can return the amount of equivalent amount of tokens the user "holds" at each point in time
          -- "user_amount_0",
          -- "user_amount_1",
          "hold_value_0",
          "hold_value_1",
          "vault_value_0",
          "vault_value_1"
        FROM time_range
        ASOF LEFT JOIN timeseries
          ON (time_range."contract_address" = timeseries."contract_address")
          AND (time_range."time_period_start" >= timeseries."time")
        -- default sort reverse chronologically
        ORDER BY "time" DESC
        -- cap limit to max, set default if not well defined
        LIMIT ${
          Math.min(Number(request.query.limit) + 1, MAX_ROWS) || DEFAULT_ROWS
        }
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        getRow: ({
          time,
          time_end,
          hold_value_0,
          hold_value_1,
          vault_value_0,
          vault_value_1,
        }) => ({
          time,
          time_end,
          hold_value_0,
          hold_value_1,
          vault_value_0,
          vault_value_1,
        }),
        getHeight: (data) =>
          Number(data.find((row) => Number(row.height) > 0)?.height),
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => name !== 'height')
              // add time units, convert tick index units
              ?.map((row) =>
                row.name === 'time'
                  ? { ...row, units: 'YYYY-MM-DD hh:mm:ss UTC' }
                  : { ...row, type: 'Float64' }
              )
          );
        },
        // flag as complete if there will be no data changes after this
        isComplete:
          !!Number(request.query.to) &&
          time.unixTimeEnd > Number(request.query.to),
        ...cacheConfig,
      }
    );
  },
};
