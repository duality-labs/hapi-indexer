WITH
toStartOfHour(addMinutes(now(), -10)) as "time_end",
addDays("time_end", -30) as "time_start",
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
-- get query range (with)
block_range AS (
  SELECT
    "timestamp",
    "height"
  FROM spacebox.raw_block_results
  WHERE "height" >= "height_start"
    AND "height" <= "height_end"
  ORDER BY "height" ASC
),
-- (
--   SELECT "timestamp"
--   FROM spacebox.dex_vaults_dex_balance
--   -- filter data early to reduce processing
--   WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
--     AND "timestamp" < "time_start"
--   -- keep original table order but descending
--   ORDER BY "height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
--   LIMIT 1
-- ) as "time_balance_start",
balance_start_row AS (
  SELECT
    "time_start" AS "timestamp",
    "height",
    "intended_token_0_balance",
    "intended_token_1_balance"
  FROM spacebox.dex_vaults_dex_balance as b
  -- filter data early to reduce processing
  WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
    AND b."height" <= "height_start"
  -- keep original table order but descending
  ORDER BY "height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
  LIMIT 1
),
-- balance_adjustment_rows AS (
--   SELECT
--     "timestamp",
--     "height"
--   FROM spacebox.raw_block_results
--   -- filter data early to reduce processing
--   WHERE "timestamp" <= "time_start"
--   -- keep original table order but descending
--   ORDER BY "height" DESC
--   LIMIT 1

--   WITH
    
--   0 as "hold_0_deposited",
--   0 as "hold_1_deposited",
--   0 as "hold_0_withdrawn",
--   0 as "hold_1_withdrawn",
--   SELECT
--     "timestamp",
--     "height",
--     "token_0_deposited",
--     "token_1_deposited",
--     "token_0_withdrawn",
--     "token_1_withdrawn",
--     sum("hold_0_deposited" - "hold_0_withdrawn") OVER cumulative_events as "hold_0",
--     sum("hold_1_deposited" - "hold_1_withdrawn") OVER cumulative_events as "hold_1",
--     "shares_in",
--     "shares_out",
--     "total_shares"
--   FROM spacebox.dex_vaults_shares as b
--   -- filter data early to reduce processing
--   WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
--     AND b."timestamp" >= "time_start"
--   -- keep original table order but descending
--   ORDER BY "height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
--   WINDOW cumulative_events AS (
--     PARTITION BY account_id          -- optional
--     ORDER BY        tx_time          -- mandatory for a running total
--     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
--   )
--   LIMIT 1
-- ),
-- balance_adjustment_rows_ AS (
--   WITH
    
--   0 as "hold_0_deposited",
--   0 as "hold_1_deposited",
--   0 as "hold_0_withdrawn",
--   0 as "hold_1_withdrawn",
--   SELECT
--     "timestamp",
--     "height",
--     "token_0_deposited",
--     "token_1_deposited",
--     "token_0_withdrawn",
--     "token_1_withdrawn",
--     sum("hold_0_deposited" - "hold_0_withdrawn") OVER cumulative_events as "hold_0",
--     sum("hold_1_deposited" - "hold_1_withdrawn") OVER cumulative_events as "hold_1",
--     "shares_in",
--     "shares_out",
--     "total_shares"
--   FROM spacebox.dex_vaults_shares as b
--   -- filter data early to reduce processing
--   WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
--     AND b."timestamp" >= "time_start"
--   -- keep original table order but descending
--   ORDER BY "height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
--   WINDOW cumulative_events AS (
--     PARTITION BY account_id          -- optional
--     ORDER BY        tx_time          -- mandatory for a running total
--     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
--   )
--   LIMIT 1
-- ),
balance_end_row AS (
  SELECT
    "time_end" AS "timestamp",
    "height",
    "intended_token_0_balance",
    "intended_token_1_balance"
  FROM spacebox.dex_vaults_dex_balance as b
  -- filter data early to reduce processing
  WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
    AND b."height" <= "height_end"
  -- keep original table order but descending
  ORDER BY "height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
  LIMIT 1
),
-- somehow grouping here uses 50% of time and 20% of memory than the projection
balance_by_height AS (
  SELECT
    "timestamp",
    "height",
    argMax("intended_token_0_balance", "sort_key") as "intended_token_0_balance",
    argMax("intended_token_1_balance", "sort_key") as "intended_token_1_balance"
  FROM spacebox.dex_vaults_dex_balance
  WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
    AND "height" > "height_start"
    AND "height" < "height_end"
  GROUP BY "height", "timestamp"
  ORDER BY "timestamp" ASC
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
  WHERE "base" = 'USDC'
    AND "quote" = 'USD'
  LIMIT 1
) as "price_id_0",
(
  SELECT "id"
  FROM price_ids
  WHERE "base" = 'NTRN'
    AND "quote" = 'USD'
  LIMIT 1
) as "price_id_1",
balance_by_height_union AS (
  SELECT
    -- range timestamp is 64bit (better for Slinky data)
    r."timestamp" as "timestamp",
    r."height" as "height",
    anyLast(b."intended_token_0_balance") OVER by_height AS "intended_token_0_balance",
    anyLast(b."intended_token_1_balance") OVER by_height AS "intended_token_1_balance",
    "price_id_0",
    "price_id_1"
  FROM block_range as r
  LEFT JOIN (
    SELECT * FROM balance_start_row
    UNION ALL
    SELECT * FROM balance_by_height
    UNION ALL
    SELECT * FROM balance_end_row
  ) as b
  ON b."height" = r."height"
  WINDOW by_height AS (
    ORDER BY "height"
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )
  ORDER BY "timestamp" ASC
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
tvl_timeseries AS (
  WITH
    (SELECT "price" FROM price_0_first_row) as "first_price_0",
    (SELECT "decimals" FROM price_0_first_row) as "first_decimals_0",
    (SELECT "price" FROM price_1_first_row) as "first_price_1",
    (SELECT "decimals" FROM price_1_first_row) as "first_decimals_1"
  SELECT
    b."timestamp" as "timestamp",
    b."height" as "height",
    b."intended_token_0_balance" as "balance_0",
    b."intended_token_1_balance" as "balance_1",
    COALESCE(p0."price", "first_price_0") as "price_0",
    COALESCE(p0."decimals", "first_decimals_0") as "decimals_0",
    COALESCE(p1."price", "first_price_1") as "price_1",
    COALESCE(p1."decimals", "first_decimals_1") as "decimals_1",
    toFloat64("price_0") * exp10(-(6 + "decimals_0")) * toFloat64("balance_0") as "tvl_0",
    toFloat64("price_1") * exp10(-(6 + "decimals_1")) * toFloat64("balance_1") as "tvl_1",
    "tvl_0" + "tvl_1" as "tvl"
  FROM balance_by_height_union as b
  -- join to closest available price of token zero
  ASOF LEFT JOIN slinky_prices_0 as p0
    ON (b."price_id_0" = p0."id")
    AND p0."timestamp" <= b."timestamp"
  -- join to closest available price of token one
  ASOF LEFT JOIN slinky_prices_1 as p1
    ON (b."price_id_1" = p1."id")
    AND p1."timestamp" <= b."timestamp"
),
tvl_valuation_periods AS (
  WITH
    tvl_timeseries_with_markers AS (
      SELECT
        *,
        lagInFrame("timestamp", 1, "time_start") OVER chronologically as "previous_timestamp",
        lagInFrame("tvl", 1, 0) OVER chronologically as "previous_tvl",
        -- use 32 bit to allow enough repeated rows for heights within 30 days
        toUInt32("tvl" != "previous_tvl") AS "is_new_run"
      FROM tvl_timeseries
      WINDOW chronologically AS (
        ORDER BY "timestamp" ASC
        ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
      )
    ),
    tvl_timeseries_with_segment_id AS (
      SELECT
        *,
        sum("is_new_run") OVER chronologically as "segment_id"
      FROM tvl_timeseries_with_markers
      WINDOW chronologically AS (
        ORDER BY "timestamp" ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      )
    ),
    tvl_timeseries_segmented AS (
      SELECT
        -- argMin(t."previous_timestamp", t."timestamp") as "previous_timestamp",
        argMin(t."timestamp", t."timestamp") as "timestamp",
        argMin(t."previous_tvl", t."timestamp") as "previous_tvl",
        argMin(t."tvl", t."timestamp") as "tvl"
      FROM tvl_timeseries_with_segment_id as t
      GROUP BY "segment_id"
    )
  SELECT
    lagInFrame("timestamp", 1, "time_start") OVER chronologically as "previous_timestamp",
    *
  FROM tvl_timeseries_segmented
  WINDOW chronologically AS (
    ORDER BY "timestamp" ASC
    ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
  )
),
apr AS (
  SELECT
    "timestamp",
    "tvl",
    greatest(0, dateDiff('ms', "previous_timestamp", "timestamp")) as "milliseconds_diff",
    if(COALESCE("previous_tvl", 0) > 0, ("tvl" - "previous_tvl") / "previous_tvl", 0) as "t"
  FROM tvl_valuation_periods
  -- SELECT sum(
  --   dateDiff('second', "timestamp", "previous_timestamp") * ("tvl" - "previous_tvl") / "previous_tvl"
  -- ) as apr
)
-- SELECT count(*) FROM tvl_valuation_periods
SELECT count(*) FROM apr LIMIT 10
-- SELECT * FROM tvl_valuation_periods ORDER BY "timestamp" ASC LIMIT 3
SETTINGS join_use_nulls=1
