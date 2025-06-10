import sql, { raw } from 'sql-template-tag';

import { Route } from '../../../types';
import { getCachedResponse } from '../../../utils/cache-query';
import {
  hours,
  inMs,
  minutes,
  WithFillTimePeriod,
  toUnixTime,
  getFillableTimePeriod,
} from '../../../utils/units';
import {
  selectVaultConfigs,
  VaultResponse,
} from '../../../common-table-expressions/vaultConfigs';

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
  vault_value_0: number;
  vault_value_1: number;
  hold_value_0: number;
  hold_value_1: number;
}

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/:contract/user/:address/pnl',
  handler: async (request, abortSignal, previousResponse) => {
    const sourceTableHeight = await getCachedResponse<{ height: string }>(
      sql`
        SELECT max("height") AS "height"
        FROM spacebox."raw_block_results"
      `,
      abortSignal
    );

    // get timeseries data height (quick query to determine cache version)
    const contractResponse = await getCachedResponse<VaultResponse>(
      sql`
          SELECT *
          FROM (${selectVaultConfigs})
          WHERE "contract_address" = ${request.params.contract}
        `,
      abortSignal,
      {
        cacheTime: 1 * minutes * inMs,
      }
    );

    const data = contractResponse.data.at(0);
    if (!data) {
      throw new Error('NotFound', { cause: 404 });
    }
    const contract = data.contract_address;
    const token0 = {
      denom: data.token_0_denom,
      decimals: data.token_0_decimals,
      maxBlocksStale: data.token_0_max_blocks_stale,
      symbol: data.token_0_symbol,
      quoteCurrency: data.token_0_quote_currency,
    };
    const token1 = {
      denom: data.token_1_denom,
      decimals: data.token_1_decimals,
      maxBlocksStale: data.token_1_max_blocks_stale,
      symbol: data.token_1_symbol,
      quoteCurrency: data.token_1_quote_currency,
    };

    const denom0 = token0.denom;
    const denom1 = token1.denom;

    // get timeseries data height (quick query to determine cache version)
    const allUpdateHeights = await Promise.all([
      getCachedResponse<{
        height: string;
        time: string;
      }>(
        sql`
            SELECT
              max(t."height") AS "height",
              argMax("timestamp", t."height") as "time"
            FROM spacebox.dex_message_event_tick_state as t
            WHERE "TokenZero" = ${denom0}
              AND "TokenOne" = ${denom1}
        `,
        abortSignal,
        { cacheTime: 1 * minutes * inMs }
      ),
      getCachedResponse<{
        height: string;
        time: string;
      }>(
        sql`
            SELECT
              max(t."height") AS "height",
              argMax("timestamp", t."height") as "time"
            FROM spacebox.bank_transfer_state as t
            WHERE "address" = ${request.params.contract}
              AND "denom" IN (${denom0}, ${denom1})
        `,
        abortSignal,
        { cacheTime: 1 * minutes * inMs }
      ),
      getCachedResponse<{
        height: string;
        time: string;
      }>(
        sql`
            SELECT
              argMax("height_to", t."timestamp") as "height",
              max(t."timestamp") as "time"
            FROM spacebox.slinky_prices as t
            WHERE "id" IN (
              SELECT "id"
              FROM spacebox.slinky_pairs
              WHERE (
                "base" = ${token0.symbol} AND "quote" = ${token0.quoteCurrency}
                OR
                "base" = ${token1.symbol} AND "quote" = ${token1.quoteCurrency}
              )
            )
        `,
        abortSignal,
        { cacheTime: 1 * minutes * inMs }
      ),
    ]);

    const currentHeight = allUpdateHeights
      .slice()
      .sort((a, b) => {
        const rowA = a.data.at(0);
        const rowB = b.data.at(0);
        return rowA && rowB
          ? Number(rowB.height) - Number(rowA.height)
          : rowA
          ? -1
          : 1;
      })
      .at(0);

    // get requested time period or default
    const timePeriods = Number(request.query.periods) || 1;
    const timePeriod = getFillableTimePeriod(request.query.period) || 'hour';
    const timePeriodLimit = (() => {
      switch (timePeriod) {
        case 'second':
          return 60 * 60; // an hour
        case 'minute':
          return 60 * 24; // a day
        case 'hour':
          return 30 * 24; // a ~month
        case 'day':
          return 365; // a ~year
        case 'week':
          return 52 * 3; // ~3 years
        default:
          return 12;
      }
    })();
    // get previous query limit
    const timePrevious = toUnixTime(previousResponse?.data.at(0)?.time);
    // get contract start time
    const timeContractStart = toUnixTime(data.created_at);
    // ClickHouse will compare either native strings or Unix timestamps
    const unixFrom = Math.max(
      timeContractStart,
      timePrevious,
      Number(request.query.from) || 0
    );
    const unixTo = Number(request.query.to) || 0;

    // get timeseries data
    return await getCachedResponse<
      Response & { height: number; apr_percentage: number },
      Response
    >(
      sql`
        WITH
          ${unixFrom} as "unix_from",
          ${unixTo} as "unix_to",
          ${contract} as "_contract_address",
          if(
            "unix_to" > 0,
            toDateTime("unix_to"),
            toStartOfInterval(
              addMinutes(now(), -10),
              INTERVAL ${timePeriods} ${raw(timePeriod)}
            )
          ) as "time_end",
          greatest(
            if (
              "unix_from" > 0,
              toStartOfInterval(
                toDateTime("unix_from"),
                INTERVAL ${timePeriods} ${raw(timePeriod)}
              ),
              toDateTime(0)
            ),
            subDate(
              "time_end",
              INTERVAL ${timePeriods * timePeriodLimit} ${raw(timePeriod)}
            )
          ) as "time_start",
          COALESCE(
            (SELECT "height"
            FROM spacebox.raw_block_results
            WHERE "timestamp" <= "time_start"
            ORDER BY "height" DESC
            LIMIT 1),
            0
          ) as "height_start",
          COALESCE(
            (SELECT "height"
            FROM spacebox.raw_block_results
            WHERE "timestamp" <= "time_end"
            ORDER BY "height" DESC
            LIMIT 1), 0
          ) as "height_end",
          vault_config AS (
            SELECT * FROM spacebox.dex_vaults_config_state
            WHERE "contract_address" = "_contract_address"
            ORDER BY "updated_at" DESC
            LIMIT 1
          ),
          block_range AS (
            SELECT
              "timestamp",
              "height",
              1 as "match_all"
            FROM spacebox.raw_block_results
            WHERE "height" >= "height_start"
              AND "height" <= "height_end"
            ORDER BY "height" ASC
          ),
          slinky_price_ids AS (
            WITH
              (
                SELECT "id"
                FROM spacebox.slinky_pairs_state
                WHERE "base" = (SELECT "token_0_symbol" FROM vault_config)
                  AND "quote" = (SELECT "token_0_quote_currency" FROM vault_config)
                LIMIT 1
              ) as "price_id_0",
              (
                SELECT "id"
                FROM spacebox.slinky_pairs_state
                WHERE "base" = (SELECT "token_1_symbol" FROM vault_config)
                  AND "quote" = (SELECT "token_1_quote_currency" FROM vault_config)
                LIMIT 1
              ) as "price_id_1"
            SELECT "price_id_0", "price_id_1"
          ),
          time_range AS (
            SELECT
              addDate(
                "time_start",
                INTERVAL "generate_series" ${raw(timePeriod)}
              ) as "timestamp",
              (SELECT "price_id_0" FROM slinky_price_ids) as "price_id_0",
              (SELECT "price_id_1" FROM slinky_price_ids) as "price_id_1",
              "_contract_address" as "contract_address"
              FROM generate_series(
                0,
                dateDiff(${raw(timePeriod)}, "time_start", "time_end")
              )
          ),
          slinky_prices_0 AS (
            SELECT *
            FROM spacebox.slinky_prices
            WHERE "id" = (SELECT "price_id_0" FROM slinky_price_ids)
          ),
          slinky_prices_1 AS (
            SELECT *
            FROM spacebox.slinky_prices
            WHERE "id" = (SELECT "price_id_1" FROM slinky_price_ids)
          ),
          price_0_first_row AS (
            SELECT
              "price",
              "decimals"
            FROM spacebox.slinky_prices_first_state
            WHERE "base" = (SELECT "token_0_symbol" FROM vault_config)
            LIMIT 1
          ),
          price_1_first_row AS (
            SELECT
              "price",
              "decimals"
            FROM spacebox.slinky_prices_first_state
            WHERE "base" = (SELECT "token_1_symbol" FROM vault_config)
            LIMIT 1
          ),
          balance_user_share AS (
            WITH deduplicated_shares AS (
              SELECT
                argMax("height", "sort_key") as "height",
                argMax("timestamp", "sort_key") as "timestamp",
                argMax("action", "sort_key") as "action",
                argMax("contract_address", "sort_key") as "contract_address",
                argMax("creator", "sort_key") as "creator",
                argMax("hold_equivalent_0", "sort_key") as "hold_equivalent_0",
                argMax("hold_equivalent_1", "sort_key") as "hold_equivalent_1",
                argMax("shares_in", "sort_key") as "shares_in",
                argMax("shares_out", "sort_key") as "shares_out",
                "sort_key"
              FROM (
                SELECT *, "sort_key"
                FROM spacebox.dex_vaults_shares_valued
                WHERE "contract_address" = "_contract_address"
              )
              GROUP BY "sort_key"
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
                  if("creator" = ${request.params.address}, "hold_equivalent_0", 0) as "hold_equivalent_0",
                  if("creator" = ${request.params.address}, "hold_equivalent_1", 0) as "hold_equivalent_1",
                  sumIf("shares_in" - "shares_out", "creator" = ${request.params.address}) OVER cumulative_events as "user_shares",
                  sum("shares_in" - "shares_out") OVER cumulative_events as "total_shares"
                `
                  : // use all of vault for calculations
                    sql`
                  "hold_equivalent_0",
                  "hold_equivalent_1",
                  1 as "user_shares",
                  1 as "total_shares"
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
                  "hold_equivalent_0" as "hold_amount_increase_0",
                  "hold_equivalent_1" as "hold_amount_increase_1",
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
                    "shares_out" > 0 OR "total_shares" > 0,
                    toFloat64("shares_out" / ("shares_out" + "total_shares")),
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
              (SELECT "token_0_decimals" FROM vault_config) as "token_decimals_0",
              (SELECT "token_1_decimals" FROM vault_config) as "token_decimals_1",
              (SELECT "price" FROM price_0_first_row) as "first_price_0",
              (SELECT "price" FROM price_1_first_row) as "first_price_1",
              (SELECT "decimals" FROM price_0_first_row) as "first_decimals_0",
              (SELECT "decimals" FROM price_1_first_row) as "first_decimals_1",
              if(p_0.timestamp = 0 AND "first_price_0" > 0, "first_price_0", p_0."price") as "slinky_price_0",
              if(p_1.timestamp = 0 AND "first_price_1" > 0, "first_price_1", p_1."price") as "slinky_price_1",
              if(p_0.timestamp = 0 AND "first_decimals_0" > 0, "first_decimals_0", p_0."decimals") as "decimals_0",
              if(p_1.timestamp = 0 AND "first_decimals_1" > 0, "first_decimals_1", p_1."decimals") as "decimals_1",
              toFloat64("slinky_price_0") * exp10(-("token_decimals_0" + "decimals_0")) as "token_price_0",
              toFloat64("slinky_price_1") * exp10(-("token_decimals_1" + "decimals_1")) as "token_price_1",
              user."hold_amount_0" as "hold_amount_0",
              user."hold_amount_1" as "hold_amount_1",
              -- TODO: fill in the times where the vault has removed shares from the dex (but kept them in wallet)
              --       by ensuring that the "token_0/1_balance" field is the correct "in wallet" amount
              if (vault."intended_token_0_balance" > 0, vault."intended_token_0_balance", vault."token_0_balance") as "vault_amount_0",
              if (vault."intended_token_1_balance" > 0, vault."intended_token_1_balance", vault."token_1_balance") as "vault_amount_1",
              if (user."total_shares" > 0, user."user_shares" / user."total_shares", 0) as "user_fraction_of_tvl"
            SELECT
              greatest(vault."height", user."height", p_0."height", p_1."height") as "height",
              -- note: timeseries periods capture events up to (<) the *end* of the period
              --       reset it back to show the start of the period time here
              subDate(t."timestamp", INTERVAL 1 ${raw(timePeriod)}) as "time",
              "token_price_0" * toFloat64("hold_amount_0") as "hold_value_0",
              "token_price_1" * toFloat64("hold_amount_1") as "hold_value_1",
              "token_price_0" * toFloat64("vault_amount_0") * "user_fraction_of_tvl" as "vault_value_0",
              "token_price_1" * toFloat64("vault_amount_1") * "user_fraction_of_tvl" as "vault_value_1"
            FROM time_range as t
            ASOF JOIN slinky_prices_0 as p_0
              ON (p_0."id" = t."price_id_0")
              AND p_0."timestamp" < t."timestamp"
            ASOF JOIN slinky_prices_1 as p_1
              ON (p_1."id" = t."price_id_1")
              AND p_1."timestamp" < t."timestamp"
            ASOF JOIN balance_hold_amount as user
              ON (user."contract_address" = t."contract_address")
              AND user."timestamp" < t."timestamp"
            ASOF JOIN (
                SELECT
                  "height",
                  "timestamp",
                  "contract_address",
                  "intended_token_0_balance",
                  "intended_token_1_balance",
                  "token_0_balance",
                  "token_1_balance",
                  "sort_key"
                FROM spacebox.dex_vaults_dex_balance
                WHERE "contract_address" = "_contract_address"
                  -- TODO: when calculating vault balances correctly allow
                  --       dex_withdrawals to set dex balance to zero and read
                  --       the account token0/1 tokens from the bank module
                  AND "action" = 'dex_deposit'
              ) as vault
              ON (vault."contract_address" = t."contract_address")
              AND vault."timestamp" < t."timestamp"
          )
          SELECT *
          FROM timeseries
          ORDER BY "time" DESC
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        getRow: ({
          time,
          hold_value_0,
          hold_value_1,
          vault_value_0,
          vault_value_1,
        }) => ({
          time,
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
          !!unixTo && toUnixTime(currentHeight?.data.at(0)?.time) > unixTo,
        cacheTime: 1 * hours * inMs,
        staleTimeMax: 1 * hours * inMs,
        staleTimeMin: 0.1 * hours * inMs,
        cacheVersion: Number(currentHeight?.data.at(0)?.height) || 0,
      }
    );
  },
};
