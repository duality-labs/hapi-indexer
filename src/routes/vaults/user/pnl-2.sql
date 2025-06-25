          WITH
            0 as "unix_from",
            0 as "unix_to",
            'neutron19legwvmazmk5cxx66pp6h9fh82k3lycrqg96nsud4h3cmzs6dkrqdqvke6' as "_contract_address",
            'neutron145sgyzmpe5rj4ssjpk3qksp99tss2k432mmm6h' as "_user_address",
            1 as "time_periods",
            24 * 30 as "hours",
            if(
              "unix_to" > 0,
              toDateTime("unix_to"),
              toStartOfInterval(addMinutes(now(), -10), INTERVAL "time_periods" hour)
            ) as "time_end",
            greatest(
              toDateTime("unix_from"),
              subDate("time_end", INTERVAL "hours" hour)
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
                INTERVAL "generate_series" hour
              ) as "timestamp",
              (SELECT "price_id_0" FROM slinky_price_ids) as "price_id_0",
              (SELECT "price_id_1" FROM slinky_price_ids) as "price_id_1",
              "_contract_address" as "contract_address"
              FROM generate_series(
                0,
                dateDiff(hour, "time_start", "time_end")
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
              if("creator" = "_user_address", "hold_equivalent_0", 0) as "hold_equivalent_0",
              if("creator" = "_user_address", "hold_equivalent_1", 0) as "hold_equivalent_1",
              "shares_in",
              "shares_out",
              sumIf("shares_in" - "shares_out", "creator" = "_user_address") OVER cumulative_events as "user_shares",
              sum("shares_in" - "shares_out") OVER cumulative_events as "total_shares"
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
              subDate(t."timestamp", INTERVAL 1 hour) as "time",
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
                AND "action" = 'dex_deposit'
              ) as vault
              ON (vault."contract_address" = t."contract_address")
              AND vault."timestamp" < t."timestamp"
          )
          SELECT *
          FROM timeseries
          ORDER BY "time" DESC