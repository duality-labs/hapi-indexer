import sql from 'sql-template-tag';

// this select statement applies the "swap volume fix" to recreate
// SwapAmountIn/SwapAmountOut for events in Neutron <= v5 that do not have them
export const selectDexTickUpdatesWithSwapAmountFix = sql`
  -- get previous reserves value by using an ordered window to select previous (by order) row data
  -- to help determine the ReservesDiff field: the current - previous Reserves value
  WITH lagInFrame("Reserves", 1, 0) OVER (
    -- partition by "pools" of reserves (they are separate per tick + fee/tranche combination)
    PARTITION BY "TokenZero", "TokenOne", "TokenIn", "TickIndex", "Fee", "TrancheKey"
    -- within the pool index partition, sort by event order
    ORDER BY "height" ASC, "block_part_index" ASC, "tx_index" ASC, "event_index" ASC
  ) as "PreviousReserves",
  -- compare this to current row data to get relative state (ReservesDiff) and
  ("Reserves" - "PreviousReserves") as "ReservesDiff"
  -- use the already derived is_swap field to compute new SwapAmountIn and SwapAmountOut attributes
  SELECT
    -- pass through materialized sort key
    t."sort_key" as "sort_key",
    -- pass through all other fields
    t.*,
    -- attach fixed computed fields
    if (
      t."SwapAmountOut" > 0,
      t."SwapAmountOut",
      -- apply swap volume fix
      if (
        -- note: all swap TickUpdate events should be DEX decrements (ReservesDiff < 0)
        "is_swap" AND "ReservesDiff" < 0,
        toUInt128(abs("ReservesDiff")),
        "SwapAmountOut"
      )
    ) as "SwapAmountOut",
    if (
      t."SwapAmountIn" > 0,
      t."SwapAmountIn",
      -- apply swap volume fix
      if (
        -- note: SwapAmountIn may have rounding errors (but this very small in practice)
        "is_swap" AND "ReservesDiff" < 0,
        toUInt128(ceiling(multiply(toFloat64(abs("ReservesDiff")), pow(1.0001, "TickIndex")))),
        "SwapAmountIn"
      )
    ) as "SwapAmountIn"
  FROM spacebox."dex_message_event_tick_update" as t
`;
