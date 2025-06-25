WITH
60 as "days",
'neutron15g0mlwynmf479ul0v0ht7xpj7jw0qy6u6gknmajeytrgqryp72rseywd3p' as "_contract_address",
toStartOfHour(addMinutes(now(), -10)) as "time_end",
addDays("time_end", 30) as "time_start",
(
  SELECT "height"
  FROM spacebox.raw_block_results
  WHERE "timestamp" <= "time_start"
  ORDER BY "height" DESC
  LIMIT 1
) as "height_start",
(
  SELECT "height"
  FROM spacebox.raw_block_results
  WHERE "timestamp" <= "time_end"
  ORDER BY "height" DESC
  LIMIT 1
) as "height_end",
vault_configs AS (
  WITH
        event_with_maybe_related_contract_attributes AS (
            SELECT
                argMax(initial."timestamp", initial."height") as "created_at",
                argMax(updated."timestamp", updated."height") as "updated_at",
                argMax(updated."height", updated."height") as "height",
                argMax(updated."txhash", updated."height") as "txhash",
                argMax(updated."event_index", updated."height") as "event_index",
                "contract_address",
                flatten(
                    arrayMap(
                        -- return attributes
                        (tuple) -> JSONExtractArrayRaw(tuple.3),
                        arraySort(
                            -- sort by height descending (most recent updates first)
                            (tuple) -> -tuple.1,
                            arrayFirst(
                                -- return only array of events that includes a 'create_token' event
                                (tuples) -> arrayExists(
                                    tuple -> tuple.2 = 'create_token',
                                    tuples
                                ),
                                [groupArray((updated."height", updated."action", updated."attributes"))]
                            )
                        )
                    )
                ) as "contract_attributes"
            FROM spacebox.dex_vaults_config_tx_event as initial
            INNER JOIN spacebox.dex_vaults_config_tx_event as updated
                ON (initial."contract_address" = updated."contract_address")
            -- start with initial vault creation event
            WHERE initial."action" = 'instantiate IMM'
            GROUP BY "contract_address"
        ),
        event_with_related_contract_attributes AS (
            SELECT *
            FROM event_with_maybe_related_contract_attributes
            WHERE notEmpty("contract_attributes")
        ),
        vault_config_events AS (
            SELECT
                "height",
                "created_at",
                "updated_at",
                "txhash",
                "event_index",
                "contract_address",
                -- add event attributes
                arrayMap(
                    (matches) -> arrayFirst((match) -> notEmpty(match), matches),
                    extractAllGroupsVertical(
                        JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'owner'), "contract_attributes"), 'value'),
                        'Addr\(\"([a-z]+[a-z0-9]{30,})"\)'
                    )
                ) AS "owner",
                -- support incorrectly named "max_blocks_stale_token_a" and "max_blocks_stale_token_b" attributes
                toUInt64OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'max_blocks_stale_token_a'), "contract_attributes"), 'value')) AS "max_blocks_stale_token_a",
                toUInt64OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'max_blocks_stale_token_b'), "contract_attributes"), 'value')) AS "max_blocks_stale_token_b",
                toUInt64OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'max_blocks_stale_token_0'), "contract_attributes"), 'value')) AS "max_blocks_stale_token_0",
                toUInt64OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'max_blocks_stale_token_1'), "contract_attributes"), 'value')) AS "max_blocks_stale_token_1",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_0_denom'), "contract_attributes"), 'value') AS "token_0_denom",
                toUInt8OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_0_decimals'), "contract_attributes"), 'value')) AS "token_0_decimals",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_0_symbol'), "contract_attributes"), 'value') AS "token_0_symbol",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_0_quote_currency'), "contract_attributes"), 'value') AS "token_0_quote_currency",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_1_denom'), "contract_attributes"), 'value') AS "token_1_denom",
                toUInt8OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_1_decimals'), "contract_attributes"), 'value')) AS "token_1_decimals",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_1_symbol'), "contract_attributes"), 'value') AS "token_1_symbol",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_1_quote_currency'), "contract_attributes"), 'value') AS "token_1_quote_currency",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'pool_id'), "contract_attributes"), 'value') AS "pool_id",
                toUInt256OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'deposit_cap'), "contract_attributes"), 'value')) AS "deposit_cap",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'oracle_contract'), "contract_attributes"), 'value') AS "oracle_contract",
                toUInt64OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'imbalance'), "contract_attributes"), 'value')) AS "imbalance",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'fee_tier_config'), "contract_attributes"), 'value') AS "fee_tier_config",
                toUInt64OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'timestamp_stale'), "contract_attributes"), 'value')) AS "timestamp_stale",
                toBool(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'paused'), "contract_attributes"), 'value')) AS "paused",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'denom'), "contract_attributes"), 'value') AS "denom",
                extractGroups("denom", 'factory\/[a-z0-9]{30,}\/([A-Z]+)-([A-Z]+)') AS estimated_token_order
            FROM event_with_related_contract_attributes
            WHERE notEmpty("denom")
        ),
        -- fill in missing values with defaults
        filled_vault_configs as (
            SELECT *,
                if(
                    "token_0_decimals" > 0,
                    "token_0_decimals",
                    if (
                        "token_0_symbol" in ('ETH', 'DYDX'),
                        18,
                        if (
                            "token_0_symbol" = 'BTC',
                            8,
                            6
                        )
                    )
                ) as "token_0_decimals",
                if(
                    "token_1_decimals" > 0,
                    "token_1_decimals",
                    if (
                        "token_1_symbol" in ('ETH', 'DYDX'),
                        18,
                        if (
                            "token_1_symbol" = 'BTC',
                            8,
                            6
                        )
                    )
                ) as "token_1_decimals"
            FROM vault_config_events
        )
    -- finally normalize the data to the correct side
    SELECT
        "height",
        "created_at",
        "updated_at",
        "contract_address",
        "owner",
        "token_0_denom",
        "token_0_decimals",
        "token_0_symbol",
        "token_0_quote_currency",
        -- support incorrectly named "max_blocks_stale_token_a" attributes
        -- these mean "max_blocks_stale_token_0"
        if(
            "max_blocks_stale_token_0" > 0,
            "max_blocks_stale_token_0",
            "max_blocks_stale_token_a"
        ) as "token_0_max_blocks_stale",
        "token_1_denom",
        "token_1_decimals",
        "token_1_symbol",
        "token_1_quote_currency",
        -- support incorrectly named "max_blocks_stale_token_b" attributes
        -- these mean "max_blocks_stale_token_1"
        if(
            "max_blocks_stale_token_1" > 0,
            "max_blocks_stale_token_1",
            "max_blocks_stale_token_b"
        ) as "token_1_max_blocks_stale",
        -- add estimated order from contract denom string to end users
        arrayFilter(
            (denom) -> notEmpty(denom),
            arrayMap(
                -- convert from symbol to denom
                (symbol) -> (
                    if (
                        symbol = "token_0_symbol",
                        "token_0_denom",
                        if (
                            symbol = "token_1_symbol",
                            "token_1_denom",
                            ''
                        )
                    )
                ),
                "estimated_token_order"
            )
        ) as "estimated_token_order",
        "pool_id",
        "deposit_cap",
        "oracle_contract",
        "imbalance",
        "fee_tier_config",
        "timestamp_stale",
        "paused",
        "denom"
    FROM filled_vault_configs
),
vault_config AS (
  SELECT * FROM vault_configs
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
-- todo: aggregate with groups instead of LIMIT 1 conditions
_balance_start_row AS (
  SELECT
    "time_start" AS "timestamp",
    "height_start" as "height",
    max(b."sort_key") as "sort_key",
    argMax("intended_token_0_balance", b."sort_key") as "intended_token_0_balance",
    argMax("intended_token_1_balance", b."sort_key") as "intended_token_1_balance",
    1 as "match_all"
  FROM (
    SELECT *, "sort_key"
    FROM spacebox.dex_vaults_dex_balance as b
    -- filter data early to reduce processing
    WHERE "contract_address" = "_contract_address"
      AND b."height" <= "height_start"
    -- keep original table order but descending
    ORDER BY b."height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
  ) as b
  GROUP BY "contract_address"
),
balance_start_row AS (
  WITH
    balace_before_start_height as (
      SELECT
        "time_start" AS "timestamp",
        "height_start" as "height",
        "sort_key",
        "intended_token_0_balance",
        "intended_token_1_balance"
      FROM spacebox.dex_vaults_dex_balance as b
      -- filter data early to reduce processing
      WHERE "contract_address" = "_contract_address"
        AND b."height" <= "height_start"
      -- keep original table order but descending
      ORDER BY b."height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
      LIMIT 1
    ),
    balace_after_start_height as (
      SELECT
        "time_start" AS "timestamp",
        "height_start" as "height",
        "sort_key",
        "intended_token_0_balance",
        "intended_token_1_balance"
      FROM spacebox.dex_vaults_dex_balance as b
      -- filter data early to reduce processing
      WHERE "contract_address" = "_contract_address"
        AND b."height" > "height_start"
      -- keep original table order but descending
      ORDER BY b."height" ASC, "block_part_index" ASC, "tx_index" ASC, "event_index" ASC
      LIMIT 1
    )
  -- we union before start height and after start height because balace_before_start_height may be empty
  SELECT *, "sort_key", 1 as "match_all"
  FROM balace_before_start_height
  UNION ALL
  SELECT *, "sort_key", 1 as "match_all"
  FROM balace_after_start_height
  ORDER BY "sort_key" ASC
  LIMIT 1
),
balance_end_row AS (
  SELECT
    "time_end" AS "timestamp",
    "height_end" as "height",
    "sort_key",
    "intended_token_0_balance",
    "intended_token_1_balance",
    1 as "match_all"
  FROM spacebox.dex_vaults_dex_balance as b
  -- filter data early to reduce processing
  WHERE "contract_address" = "_contract_address"
    AND b."height" <= "height_end"
  -- keep original table order but descending
  ORDER BY b."height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
  LIMIT 1
),
price_ids AS (
  WITH price_ids_by_height AS (
    SELECT
      "base",
      "quote",
      "id",
      maxMerge("height_to") as "height"
    FROM spacebox.slinky_pairs
    GROUP BY "base", "quote", "id"
  )
  SELECT
    "base",
    "quote",
    argMax("id", "height") as "id"
  FROM price_ids_by_height
  GROUP BY "base", "quote"
),
(
  SELECT "id"
  FROM price_ids
  WHERE "base" = (SELECT "token_0_symbol" FROM vault_config)
    AND "quote" = 'USD'
  LIMIT 1
) as "price_id_0",
(
  SELECT "id"
  FROM price_ids
  WHERE "base" = (SELECT "token_1_symbol" FROM vault_config)
    AND "quote" = 'USD'
  LIMIT 1
) as "price_id_1",
balance_increase_rows AS (
  WITH
    balance_transfers as (
      SELECT
        "height",
        "sort_key",
        "token_0_deposited",
        "token_1_deposited"
      FROM spacebox.dex_vaults_shares
      WHERE "action" = 'deposit'
        AND "contract_address" = "_contract_address"
        AND "height" >= "height_start"
        AND "height" <= "height_end"
      ORDER BY "sort_key" ASC
    ),
    balance_union AS (
      SELECT
        "height",
        "sort_key",
        "intended_token_0_balance" as "token_0_deposited",
        "intended_token_1_balance" as "token_1_deposited"
      FROM balance_start_row
      UNION ALL
      SELECT
        "height",
        "sort_key",
        -- calculate deposit value by amount increased
        "token_0_deposited",
        "token_1_deposited"
      FROM balance_transfers
    )
    -- add high resolution timestamps and price ids
    SELECT
      r."timestamp" as "timestamp",
      b."height" as "height",
      b."sort_key" as "sort_key",
      b."token_0_deposited" as "token_0_deposited",
      b."token_1_deposited" as "token_1_deposited",
      "price_id_0",
      "price_id_1"
    FROM balance_union as b
    JOIN block_range as r
    ON (b."height" = r."height")
    ORDER BY "sort_key" ASC
),
balance_decrease_rows AS (
  SELECT
    r."timestamp" as "timestamp",
    "height",
    "sort_key",
    -- calculate withdrawal value by percentage reduction of vault
    -- note: using calculated USD value may make cumulative balance negative
    "shares_out",
    "total_shares"
  FROM spacebox.dex_vaults_shares as s
  JOIN block_range as r
  ON (s."height" = r."height")
  WHERE "action" = 'withdrawal'
    AND "contract_address" = "_contract_address"
    AND "height" >= "height_start"
    AND "height" <= "height_end"
  ORDER BY "sort_key" ASC
),
slinky_prices_0 AS (
  SELECT *
  FROM spacebox.slinky_prices
  WHERE "id" = (
    SELECT "id"
    FROM price_ids
    WHERE "base" = 'USDC'
      AND "quote" = 'USD'
    LIMIT 1
  )
),
slinky_prices_1 AS (
  SELECT *
  FROM spacebox.slinky_prices
  WHERE "id" = (
    SELECT "id"
    FROM price_ids
    WHERE "base" = 'NTRN'
      AND "quote" = 'USD'
    LIMIT 1
  )
),
price_0_first_row AS (
  SELECT
    "price",
    "decimals"
  FROM slinky_prices_0
  ORDER BY "id" ASC, "timestamp" ASC
  LIMIT 1
),
price_1_first_row AS (
  SELECT
    "price",
    "decimals"
  FROM slinky_prices_1
  ORDER BY "id" ASC, "timestamp" ASC
  LIMIT 1
),
balance_hold_amount AS (
  WITH
    hold_amount_increases AS (
      WITH
        (SELECT "token_0_decimals" FROM vault_config) as "token_decimals_0",
        (SELECT "token_1_decimals" FROM vault_config) as "token_decimals_1",
        (SELECT "price" FROM price_0_first_row) as "first_price_0",
        (SELECT "price" FROM price_1_first_row) as "first_price_1",
        (SELECT "decimals" FROM price_0_first_row) as "first_decimals_0",
        (SELECT "decimals" FROM price_1_first_row) as "first_decimals_1",
        if(p0.timestamp = 0 AND "first_price_0" > 0, "first_price_0", p0."price") as "slinky_price_0",
        if(p1.timestamp = 0 AND "first_price_1" > 0, "first_price_1", p1."price") as "slinky_price_1",
        if(p0.timestamp = 0 AND "first_decimals_0" > 0, "first_decimals_0", p0."decimals") as "decimals_0",
        if(p1.timestamp = 0 AND "first_decimals_1" > 0, "first_decimals_1", p1."decimals") as "decimals_1",
        toFloat64("slinky_price_0") * exp10(-("token_decimals_0" + "decimals_0")) as "token_price_0",
        toFloat64("slinky_price_1") * exp10(-("token_decimals_1" + "decimals_1")) as "token_price_1",
        "token_price_0" * toFloat64(b."token_0_deposited") as "value_0",
        "token_price_1" * toFloat64(b."token_1_deposited") as "value_1",
        "value_0" + "value_1" as "value"
      SELECT
        b."timestamp" as "timestamp",
        b."height" as "height",
        "value" / 2 / "token_price_0" as "hold_amount_increase_0",
        "value" / 2 / "token_price_1" as "hold_amount_increase_1",
        b."sort_key"
      FROM balance_increase_rows as b
      -- join to closest available price of token zero
      ASOF LEFT JOIN slinky_prices_0 as p0
        ON (b."price_id_0" = p0."id")
        AND p0."timestamp" <= b."timestamp"
      -- join to closest available price of token one
      ASOF LEFT JOIN slinky_prices_1 as p1
        ON (b."price_id_1" = p1."id")
        AND p1."timestamp" <= b."timestamp"
    ),
    hold_amount_decreases AS (
      SELECT
        "timestamp",
        "height",
        "sort_key",
        toFloat64("shares_out" / ("shares_out" + "total_shares")) as "share_fraction_reduction"
      FROM balance_decrease_rows
    ),
    hold_adjustments_union AS (
      SELECT
        "timestamp",
        "height",
        "sort_key",
        "hold_amount_increase_0",
        "hold_amount_increase_1",
        0 as "share_fraction_reduction"
      FROM hold_amount_increases
      UNION ALL
      SELECT
        "timestamp",
        "height",
        "sort_key",
        0 as "hold_amount_increase_0",
        0 as "hold_amount_increase_1",
        "share_fraction_reduction"
      FROM hold_amount_decreases
    ),
    -- ensure there are no duplicate events for each event index before SUM
    hold_adjustments_by_event AS (
      SELECT
        "timestamp",
        "height",
        "sort_key",
        anyLast("hold_amount_increase_0") as "hold_amount_increase_0",
        anyLast("hold_amount_increase_1") as "hold_amount_increase_1",
        anyLast("share_fraction_reduction") as "share_fraction_reduction"
      FROM hold_adjustments_union
      GROUP BY "height", "timestamp", "sort_key"
    ),
    hold_amount_by_event AS (
      WITH
        /* ---- 1. build the running product (P_i) ---- */
        prod AS (
          SELECT
            "timestamp",
            "height",
            "sort_key",
            "hold_amount_increase_0",
            "hold_amount_increase_1",

            /* prefix-product P_i  =  exp( Σ log(mult) ) */
            exp(
              sum( log( toFloat64(1 - "share_fraction_reduction") ) ) OVER (
                ORDER BY "sort_key"
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              )
            ) AS "P_i"
          FROM hold_adjustments_by_event
        ),
        /* ---- 2. derive scaled increases ---- */
        calc AS (
          SELECT
            "timestamp",
            "height",
            "sort_key",
            "P_i",
            /* scaled add_k / P */
            toFloat64("hold_amount_increase_0") / "P_i" AS "scaled_hold_amount_increase_0",
            toFloat64("hold_amount_increase_1") / "P_i" AS "scaled_hold_amount_increase_1"
          FROM prod
        )
        /* ---- 3. get running sum, final total ---- */
      SELECT
        "timestamp",
        "height",
        "sort_key",
        /* running sum of scaled_add = Σ add_k / P */
        /* final cumulative total is prefix-product * running-sum */
        "P_i" * sum("scaled_hold_amount_increase_0") OVER cumulative_events AS "hold_amount_0",
        "P_i" * sum("scaled_hold_amount_increase_1") OVER cumulative_events AS "hold_amount_1"
      FROM calc
      WINDOW cumulative_events AS (
        ORDER BY "sort_key" ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      )
      ORDER BY "sort_key"
    )
    -- get the last value at each height
    SELECT
      argMax("hold_amount_0", "sort_key") as "hold_amount_0",
      argMax("hold_amount_1", "sort_key") as "hold_amount_1",
      "price_id_0",
      "price_id_1",
      1 as "match_all"
    FROM hold_amount_by_event
),
vault_end_state AS (
  WITH
    (SELECT "token_0_decimals" FROM vault_config) as "token_decimals_0",
    (SELECT "token_1_decimals" FROM vault_config) as "token_decimals_1",
    (SELECT "price" FROM price_0_first_row) as "first_price_0",
    (SELECT "price" FROM price_1_first_row) as "first_price_1",
    (SELECT "decimals" FROM price_0_first_row) as "first_decimals_0",
    (SELECT "decimals" FROM price_1_first_row) as "first_decimals_1",
    if(p0.timestamp = 0 AND "first_price_0" > 0, "first_price_0", p0."price") as "slinky_price_0",
    if(p1.timestamp = 0 AND "first_price_1" > 0, "first_price_1", p1."price") as "slinky_price_1",
    if(p0.timestamp = 0 AND "first_decimals_0" > 0, "first_decimals_0", p0."decimals") as "decimals_0",
    if(p1.timestamp = 0 AND "first_decimals_1" > 0, "first_decimals_1", p1."decimals") as "decimals_1",
    toFloat64("slinky_price_0") * exp10(-("token_decimals_0" + "decimals_0")) as "token_price_0",
    toFloat64("slinky_price_1") * exp10(-("token_decimals_1" + "decimals_1")) as "token_price_1",
    "token_price_0" * toFloat64(h."hold_amount_0") as "hold_value_0",
    "token_price_1" * toFloat64(h."hold_amount_1") as "hold_value_1",
    COALESCE("hold_value_0" + "hold_value_1", 0) as "hold_value",
    "token_price_0" * toFloat64(b."vault_amount_0") as "vault_value_0",
    "token_price_1" * toFloat64(b."vault_amount_1") as "vault_value_1",
    COALESCE("vault_value_0" + "vault_value_1", 0) as "vault_value"
  SELECT
    b."timestamp" as "timestamp",
    b."height" as "height",
    h."hold_amount_0" as "hold_amount_0",
    h."hold_amount_1" as "hold_amount_1",
    b."vault_amount_0" as "vault_amount_0",
    b."vault_amount_1" as "vault_amount_1",
    "hold_value",
    "vault_value"
  FROM (
    SELECT
      "timestamp",
      "height",
      "intended_token_0_balance" as "vault_amount_0",
      "intended_token_1_balance" as "vault_amount_1"
    FROM balance_end_row
  ) as b
  JOIN  (
    SELECT
      "hold_amount_0",
      "hold_amount_1",
      "price_id_0",
      "price_id_1"
    FROM balance_hold_amount
  ) as h
  ON 1 = 1
  -- join to closest available price of token zero
  ASOF LEFT JOIN slinky_prices_0 as p0
    ON (h."price_id_0" = p0."id")
    AND p0."timestamp" <= b."timestamp"
  -- join to closest available price of token one
  ASOF LEFT JOIN slinky_prices_1 as p1
    ON (h."price_id_1" = p1."id")
    AND p1."timestamp" <= b."timestamp"
)
SELECT *
-- SELECT ("vault_value" - "hold_value") / "hold_value" / "days" * 365 as "apr"
FROM vault_end_state
