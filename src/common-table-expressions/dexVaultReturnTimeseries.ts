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
  minimumBasisTVL = 1000, // minimum performance basis of $1000 considered only
}: {
  contractAddress?: string;
  period?: TimePeriod;
  periods?: number;
  unixTimeStart?: number;
  unixTimeEnd?: number;
  limit?: number;
  minimumBasisTVL?: number;
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
              toStartOfMinute("timestamp")                            AS "time_minute",   -- use minutes to align period with aggregated table
              sum("value_deposited" - "value_withdrawn")              AS "value_changed"
            FROM deduplicated_shares
            GROUP BY
              "contract_address",
              "time_minute"
          ),
          -- get balance changes over the same time period
          period_balances AS (
            SELECT
              "contract_address",
              toStartOfMinute("timestamp")                            AS "time_minute",   -- use minutes to align period with aggregated table
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
              "time_minute"
            ORDER BY "time_minute"
          ),
          joined_periods AS (
            SELECT
              b."contract_address" as "contract_address",
              b."time_minute" as "time_minute",
              b."balance_count" > 0 as "has_balance_row",
              sum(b."balance_count") OVER cumulative_periods_per_contract as "balances_counted",
              b."price_0_open" as "price_0_open",
              b."price_1_open" as "price_1_open",
              b."price_0_close" as "price_0_close",
              b."price_1_close" as "price_1_close",
              countIf(b."price_0_close" + b."price_1_close" > 0) OVER cumulative_periods_per_contract as "has_price",
              b."value_open" as "value_open",
              b."value_close" as "value_close",
              s."value_changed" as "value_changed"
            FROM period_balances as b
            FULL OUTER JOIN grouped_share_movements as s
            USING "contract_address", "time_minute"
            WINDOW cumulative_periods_per_contract as (
              PARTITION BY "contract_address"
              ORDER BY "time_minute" ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )
          ),
          filled_period_balances AS (
            SELECT
              "contract_address",
              "time_minute",
              "has_price",
              anyLastIfOrNull("price_0_open", "has_balance_row" = 1) OVER cumulative_contract_non_balance_periods as "price_0_open",
              anyLastIfOrNull("price_1_open", "has_balance_row" = 1) OVER cumulative_contract_non_balance_periods as "price_1_open",
              anyLastIfOrNull("price_0_close", "has_balance_row" = 1) OVER cumulative_contract_non_balance_periods as "price_0_close",
              anyLastIfOrNull("price_1_close", "has_balance_row" = 1) OVER cumulative_contract_non_balance_periods as "price_1_close",
              if (
                "has_price" > 0,
                greatest(0, sum(if("has_balance_row" = 1, "value_close", "value_changed")) OVER cumulative_contract_non_balance_periods),
                NULL
              ) as "approximate_close",
              if (
                "has_price" > 0,
                if("has_balance_row" = 1, "value_open", "approximate_close" - "value_changed"),
                NULL
              ) as "approximate_open"
            FROM joined_periods
            WINDOW cumulative_contract_non_balance_periods as (
              PARTITION BY "contract_address", "balances_counted"
              ORDER BY "time_minute" ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )
          )
        SELECT
          "contract_address",
          "time_minute",
          "approximate_close" as "value_close",
          "price_0_close",
          "price_1_close",
          COALESCE(lagInFrame("value_close", 1) OVER c_time, "approximate_open", 0)  AS "prev_value_close",      -- previous last value in the period
          COALESCE(lagInFrame("price_0_close", 1) OVER c_time, "price_0_open", 0)    AS "prev_price_0_close",    -- previous price_0 in the period
          COALESCE(lagInFrame("price_1_close", 1) OVER c_time, "price_1_open", 0)    AS "prev_price_1_close"     -- previous price_1 in the period
        FROM filled_period_balances
        WINDOW c_time AS (
          PARTITION BY "contract_address"
          ORDER BY "time_minute" ASC
          ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
        )
      ),

      /* ---------- 3.  CASH-FLOWS (transfer_updates) ---------- */
      flows AS (
        SELECT
          "contract_address",
          toStartOfMinute("timestamp")         AS "time_minute",   -- use minutes to align period with aggregated table

          /* raw deposits-minus-withdrawals */
          sum("value_deposited")               AS "value_deposited",
          sum("value_withdrawn")               AS "value_withdrawn"
        FROM deduplicated_shares
        GROUP BY
          "contract_address",
          "time_minute"
      ),

      /* ---------- 4.  JOIN & CALCULATE RETURNS ---------- */
      timeseries_minute_returns AS (
        WITH
          greatest(${minimumBasisTVL}, b."prev_value_close" + coalesce(f."value_deposited", 0))     AS "period_value_open",
          greatest(${minimumBasisTVL}, b."value_close" + coalesce(f."value_withdrawn", 0))          AS "period_value_close"
        SELECT
          b."contract_address",
          b."time_minute",

          /* basis: the value on which we are calculating these returns ------ */
          if("period_value_open" > 0, "period_value_open", 0)         AS "basis_usd",
          if("period_value_close" > 0, "period_value_close", 0)       AS "final_usd",

          /* hold return (how much return by holding 50/50 value) ------ */
          if(
            "period_value_open" > 0 AND COALESCE(b."prev_price_0_close", 0) > 0,
            b."price_0_close" / b."prev_price_0_close" - 1,
            0
          )                                                           AS "hold_0_minute_return_percent",
          if(
            "period_value_open" > 0 AND COALESCE(b."prev_price_1_close", 0) > 0,
            b."price_1_close" / b."prev_price_1_close" - 1,
            0
          )                                                           AS "hold_1_minute_return_percent",
          (
            "hold_0_minute_return_percent" +
            "hold_1_minute_return_percent"
          ) / 2                                                       AS "hold_minute_return_percent",
          "basis_usd" * "hold_minute_return_percent"                  AS "hold_minute_return_usd",
          "basis_usd" + "hold_minute_return_usd"                      AS "hold_minute_value_usd",

          /* period return (assuming flows happen at ends of periods) ------------------- */
          -- note: this will underestimate returns in periods where deposits happen
          --       and underestimate returns in periods when withdrawals happen
          "final_usd"                                                 AS "vault_minute_value_usd",
          "final_usd" - "basis_usd"                                   AS "vault_minute_return_usd",
          if(
            "basis_usd" > 0,
            "vault_minute_return_usd" / "basis_usd",
            0
          )                                                           AS "vault_minute_return_percent",

          /* compute vault over hold percent for every period ------ */
          if(
            "hold_minute_value_usd" > 0,
            "vault_minute_value_usd" / "hold_minute_value_usd" - 1,
            -1
          )                                                           AS "vault_over_hold_minute_percent"

        FROM balances AS b
        LEFT JOIN flows AS f
          ON  b."contract_address" = f."contract_address"
          AND b."time_minute" = f."time_minute"
        WHERE b."value_close" IS NOT NULL
      ),

      /* ---------- 5.  return aggregation to requested time period ---------- */
      timeseries_period_returns AS (
        SELECT
          "contract_address",
          toStartOfInterval("time_minute", ${raw(
            interval
          )})                                                         AS "time_period",   -- e.g. toStartOfHour()

          /* product(1 + r_minute) - 1  in a stable way */
          exp(sumKahan(log1p("vault_minute_return_percent"))) - 1     AS "vault_return_percent",
          exp(sumKahan(log1p("hold_minute_return_percent"))) - 1      AS "hold_return_percent",
          exp(sumKahan(log1p("hold_0_minute_return_percent"))) - 1    AS "hold_0_return_percent",
          exp(sumKahan(log1p("hold_1_minute_return_percent"))) - 1    AS "hold_1_return_percent",
          exp(sumKahan(log1p("vault_over_hold_minute_percent"))) - 1  AS "vault_over_hold_percent",

          /* Linear annualisation (APR) ------------------------------------ */
          "vault_return_percent" * periods_per_year                   AS "vault_apr_period",
          "hold_return_percent" * periods_per_year                    AS "hold_apr_period",
          "hold_0_return_percent" * periods_per_year                  AS "hold_0_apr_period",
          "hold_1_return_percent" * periods_per_year                  AS "hold_1_apr_period",
          "vault_over_hold_percent" * periods_per_year                AS "vault_over_hold_apr_period",

          /* Compounded annualisation (APY) ------------------------------- */
          pow(1 + "vault_over_hold_percent", periods_per_year) - 1    AS "vault_over_hold_apy_period"
        FROM timeseries_minute_returns
        GROUP BY
          "contract_address",
          "time_period"
      )
    SELECT * from timeseries_period_returns
    WHERE isFinite("vault_return_percent")
  `;
}
