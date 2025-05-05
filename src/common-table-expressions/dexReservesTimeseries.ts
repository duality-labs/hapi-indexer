import sql from 'sql-template-tag';

export default function dexReservesTimeseries(
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
          if ("credit" = 1, "shares" * "is_address", -"shares" * "is_address") as "address_shares_delta",
          if ("credit" = 1, "shares", -"shares") as "total_shares_delta"
        FROM spacebox.dex_shares_by_pool
        -- filter data early to reduce processing
        WHERE
          -- filter to pair
          "TokenZero" = ${denom0} AND
          "TokenOne" = ${denom1}
      ),
      dex_reserves_deltas AS (
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
          -- reserves diff across each individual pool
          "Reserves" - lagInFrame("Reserves", 1, toUInt256(0)) OVER (
            -- partition by pool
            PARTITION BY
              "TokenZero",
              "TokenOne",
              "TokenIn",
              "TickIndex",
              "Fee",
              "TrancheKey"
            -- sort by event order
            ORDER BY "sort_key" ASC
          ) AS "ReservesDelta"
        FROM spacebox.dex_message_event_tick_update
        -- filter data early to reduce processing
        WHERE
          -- filter to pair
          "TokenZero" = ${denom0} AND
          "TokenOne" = ${denom1} AND
          -- do not include tranches (limit order liquidity)
          empty("TrancheKey")
      ),
      address_reserves_deltas_union AS (
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
          "ReservesDelta",
          0 as "address_shares_delta",
          0 as "total_shares_delta"
        FROM dex_reserves_deltas
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
          0 as "ReservesDelta",
          "address_shares_delta",
          "total_shares_delta"
        FROM address_shares_deltas
      ),
      -- perform cumulative sum across reserves of all pools within the pair
      sum("address_shares_delta") OVER cumulative_events as "address_shares",
      sum("total_shares_delta") OVER cumulative_events as "total_shares",
      sum("ReservesDelta") OVER cumulative_events as "total_reserves"
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
        "total_shares" > 0,
        "total_reserves" * "address_shares" / "total_shares",
        0
      ) as "address_reserves",
      "total_reserves"
    FROM address_reserves_deltas_union
    WINDOW cumulative_events AS (
      -- partition sums to each pool
      PARTITION BY "TokenZero", "TokenOne", "TokenIn", "TickIndex", "Fee"
      ORDER BY "sort_key" ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )
  `;
}
