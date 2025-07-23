import sql, { raw } from 'sql-template-tag';
import { TimePeriod } from '../utils/units';
import { endTime } from '../routes/vaults/_common';

export default function dexVaultReturnTimeseries({
  contractAddress,
  period = 'hour',
  periods = 1,
  unixTimeStart,
  unixTimeEnd,
  limit = 30 * 24, // 30 days worth of hours
}: {
  contractAddress?: string;
  period?: TimePeriod;
  periods?: number;
  unixTimeStart?: number;
  unixTimeEnd?: number;
  limit?: number;
} = {}) {
  const interval = `INTERVAL ${periods} ${period}`;
  return sql`
    WITH

      /* ---------- 1. CONFIGURATION ---------- */
      timeDiff(NOW(), dateAdd(NOW(), ${raw(
        interval
      )}))          AS period_secs,       -- period time in seconds
      60 * 60 * 24 * 365 / period_secs                                    AS periods_per_year,  -- calculate annualized number of periods

      time_period as (
        SELECT
          toDateTime64(${
            unixTimeStart ||
            sql`subtractSeconds("time_end", period_secs * ${limit})`
          }, 9) as "time_start",
          toDateTime64(${unixTimeEnd || endTime}, 9) as "time_end"
      ),

      deduplicated_shares AS (
        SELECT
          argMax("timestamp", "timestamp_version") as "timestamp",
          "height",
          "block_part_index",
          "tx_index",
          "event_index",
          argMax("contract_address", "timestamp_version") as "contract_address",
          argMax("value_deposited", "timestamp_version") as "value_deposited",
          argMax("value_withdrawn", "timestamp_version") as "value_withdrawn"
        FROM spacebox.dex_vaults_shares_valued as s
        WHERE s."timestamp" >= (SELECT "time_start" FROM time_period)
          AND s."timestamp" < (SELECT "time_end" FROM time_period)
          ${
            contractAddress
              ? sql`AND s."contract_address" = ${contractAddress}`
              : raw('')
          }
        GROUP BY
          "height",
          "block_part_index",
          "tx_index",
          "event_index"
      ),

      /* ---------- 2.  OPEN & CLOSE BALANCES (balance_updates) ---------- */
      balances AS (
        WITH
          -- group share changes into time periods
          grouped_share_movements AS (
            SELECT
              "contract_address",
              toStartOfInterval("timestamp", ${raw(
                interval
              )})        AS "time_period",   -- e.g. toStartOfHour()
              sum("value_deposited" - "value_withdrawn") as "value_changed"
            FROM deduplicated_shares
            GROUP BY
              "contract_address",
              "time_period"
          ),
          -- get balance changes over the same time period
          period_balances AS (
            SELECT
              "contract_address",
              toStartOfInterval("timestamp", ${raw(
                interval
              )})        AS "time_period",   -- e.g. toStartOfHour()
              count()                                                 AS "balance_count",
              argMin("token_0_value" + "token_1_value", "timestamp")  AS "value_open",    -- first value in the period
              argMax("token_0_value" + "token_1_value", "timestamp")  AS "value_close",   -- last value in the period
              argMin("token_0_price", "timestamp")                    AS "price_0_open",  -- first price_0 in the period
              argMin("token_1_price", "timestamp")                    AS "price_1_open",  -- first price_1 in the period
              argMax("token_0_price", "timestamp")                    AS "price_0_close", -- last price_0 in the period
              argMax("token_1_price", "timestamp")                    AS "price_1_close"  -- last price_1 in the period
            FROM spacebox.dex_vaults_dex_balance_valued_by_minute as b
            -- remove unvalued rows (before prices) from calculations
            WHERE "token_0_value" + "token_1_value" > 0
              AND "timestamp" >= (SELECT "time_start" FROM time_period)
              AND "timestamp" < (SELECT "time_end" FROM time_period)
              ${
                contractAddress
                  ? sql`AND b."contract_address" = ${contractAddress}`
                  : raw('')
              }
            GROUP BY
              "contract_address",
              "time_period"
            ORDER BY "time_period"
          ),
          joined_periods AS (
            SELECT
              b."contract_address" as "contract_address",
              b."time_period" as "time_period",
              b."balance_count" > 0 as "has_balance_row",
              sum(b."balance_count") OVER cumulative_periods_per_contract as "balances_counted",
              b."price_0_open" as "price_0_open",
              b."price_1_open" as "price_1_open",
              b."price_0_close" as "price_0_close",
              b."price_1_close" as "price_1_close",
              b."value_open" as "value_open",
              b."value_close" as "value_close",
              s."value_changed" as "value_changed"
            FROM period_balances as b
            FULL OUTER JOIN grouped_share_movements as s
            USING "contract_address", "time_period"
            WINDOW cumulative_periods_per_contract as (
              PARTITION BY "contract_address"
              ORDER BY "time_period" ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )
          ),
          filled_period_balances AS (
            SELECT
              "contract_address",
              "time_period",
              anyLastIf("price_0_open", "has_balance_row" = 1) OVER cumulative_contract_non_balance_periods as "price_0_open",
              anyLastIf("price_1_open", "has_balance_row" = 1) OVER cumulative_contract_non_balance_periods as "price_1_open",
              anyLastIf("price_0_close", "has_balance_row" = 1) OVER cumulative_contract_non_balance_periods as "price_0_close",
              anyLastIf("price_1_close", "has_balance_row" = 1) OVER cumulative_contract_non_balance_periods as "price_1_close",
              greatest(0, sum(if("has_balance_row" = 1, "value_close", "value_changed")) OVER cumulative_contract_non_balance_periods) as "approximate_close",
              if("has_balance_row" = 1, "value_open", "approximate_close" - "value_changed") as "approximate_open"
            FROM joined_periods
            WINDOW cumulative_contract_non_balance_periods as (
              PARTITION BY "contract_address", "balances_counted"
              ORDER BY "time_period" ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )
          )
        SELECT
          "contract_address",
          "time_period",
          "approximate_close" as "value_close",
          "price_0_close",
          "price_1_close",
          lagInFrame("value_close", 1, "approximate_open") OVER c_time  AS "prev_value_close",      -- previous last value in the period
          lagInFrame("price_0_close", 1, "price_0_open") OVER c_time    AS "prev_price_0_close",    -- previous price_0 in the period
          lagInFrame("price_1_close", 1, "price_1_open") OVER c_time    AS "prev_price_1_close"     -- previous price_1 in the period
        FROM filled_period_balances
        WINDOW c_time AS (
          PARTITION BY contract_address
          ORDER BY time_period ASC
          ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
        )
      ),

      /* ---------- 3.  CASH-FLOWS (transfer_updates) ---------- */
      flows AS (
        SELECT
          "contract_address",
          toStartOfInterval("timestamp", ${raw(
            interval
          )})            AS "time_period",   -- e.g. toStartOfHour()

          /* raw deposits-minus-withdrawals */
          sum("value_deposited") - sum("value_withdrawn")             AS "net_flow",

          /* Modified-Dietz weighting:
          weight = fraction of the period the cash remains invested          */
          sum(
            ("value_deposited" - "value_withdrawn")
            * (period_secs - (toUnixTimestamp("timestamp") - toUnixTimestamp("time_period")))
            / period_secs
          )                                                           AS "weighted_flow"
        FROM deduplicated_shares
        GROUP BY
          "contract_address",
          "time_period"
      ),

      /* ---------- 4.  JOIN & CALCULATE RETURNS ---------- */
      timeseries_period_returns AS (
        SELECT
          b."contract_address",
          b."time_period",

          /* hold return (how much return by holding 50/50 value) ------ */
          if(b."prev_price_0_close" > 0, b."price_0_close" / b."prev_price_0_close", 1) / 2 +
          if(b."prev_price_1_close" > 0, b."price_1_close" / b."prev_price_1_close", 1) / 2 - 1   AS "hold_return",

          /* Modified-Dietz money-weighted period return ------------------- */
          (b."value_close" - b."prev_value_close" - coalesce(f."net_flow", 0))
          / (b."prev_value_close" + coalesce(f."weighted_flow", 0))                               AS "vault_return",

          /* Linear annualisation (APR) ------------------------------------ */
          "vault_return" * periods_per_year                           AS "vault_apr_period",
          "hold_return" * periods_per_year                            AS "hold_apr_period",

          /* Compounded annualisation (APY) ------------------------------- */
          pow(1 + "vault_return", periods_per_year) - 1               AS "apy_period"
        FROM balances AS b
        LEFT JOIN flows AS f
          ON  b."contract_address" = f."contract_address"
          AND b."time_period" = f."time_period"
      )
    SELECT * from timeseries_period_returns
  `;
}
