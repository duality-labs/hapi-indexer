import sql from 'sql-template-tag';

export default function dexSwapVolumeTimeseries(
  address: string,
  denom0: string,
  denom1: string
) {
  return sql`
    WITH
      address_shares_deltas AS (
        WITH "Receiver" = ${address} as "is_address"
        SELECT
          -- sorting
          "timestamp",
          "height",
          "sort_key",
          -- pool index
          "TokenZero",
          "TokenOne",
          "TokenIn",
          "TickIndex",
          "Fee",
          -- values
          "total_shares_delta" * "is_address" as "address_shares_delta",
          if ("credit" = 1, "shares", -"shares") as "total_shares_delta"
        FROM spacebox.dex_shares_by_pool
        -- filter data early to reduce processing
        WHERE
          -- filter to pair
          "TokenZero" = ${denom0} AND
          "TokenOne" = ${denom1}
      ),
      dex_volumes AS (
        SELECT
          -- sorting
          "timestamp",
          "height",
          "sort_key",
          -- pool index
          "TokenZero",
          "TokenOne",
          "TokenIn",
          "TickIndex",
          "Fee",
          -- get swap volume+fees in token in units
          "SwapAmountIn" as "total_volume_and_fees",
          -- fee basis is 1 point = 0.001%
          "SwapAmountIn" * "Fee" / 100000 as "total_fees"
        FROM spacebox.dex_message_event_tick_update
        -- filter data early to reduce processing
        WHERE
          -- filter to swaps
          "is_swap" = 1 AND
          -- filter to pair
          "TokenZero" = ${denom0} AND
          "TokenOne" = ${denom1} AND
          -- do not include tranches (limit order liquidity)
          empty("TrancheKey")
      ),
      address_volumes_union AS (
        SELECT
          -- sorting
          "timestamp",
          "height",
          "sort_key",
          -- pool index
          "TokenZero",
          "TokenOne",
          "TokenIn",
          "TickIndex",
          "Fee",
          -- values
          "total_volume_and_fees",
          "total_fees",
          0 as "address_shares_delta",
          0 as "total_shares_delta"
        FROM dex_volumes
        UNION ALL
        SELECT
          -- sorting
          "timestamp",
          "height",
          "sort_key",
          -- pool index
          "TokenZero",
          "TokenOne",
          "TokenIn",
          "TickIndex",
          "Fee",
          -- values
          0 as "total_volume_and_fees",
          0 as "total_fees",
          "address_shares_delta",
          "total_shares_delta"
        FROM address_shares_deltas
      ),
      address_volumes as (
        WITH
          -- perform cumulative sum of address shares of all pools within the pair
          sum("address_shares_delta") OVER cumulative_events as "address_shares",
          sum("total_shares_delta") OVER cumulative_events as "total_shares"
        SELECT
          "timestamp",
          "height",
          "sort_key",
          -- pool index
          "TokenZero",
          "TokenOne",
          "TokenIn",
          "TickIndex",
          "Fee",
          -- values
          if (
            "address_shares" > 0 AND "total_shares" > 0,
            toFloat64("total_volume_and_fees") * ("address_shares" / "total_shares"),
            0
          ) as "address_volume_and_fees",
          if (
            "address_shares" > 0 AND "total_shares" > 0,
            "total_fees" * ("address_shares" / "total_shares"),
            0
          ) as "address_fees",
          "total_volume_and_fees",
          "total_fees"
        FROM address_volumes_union
        WINDOW cumulative_events AS (
          -- partition sums to each pool
          PARTITION BY "TokenZero", "TokenOne", "TokenIn", "TickIndex", "Fee"
          ORDER BY "sort_key" ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )
      )
    SELECT *
    FROM address_volumes
    WHERE "address_volume_and_fees" > 0
  `;
}
