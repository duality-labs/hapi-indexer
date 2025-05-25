import sql from 'sql-template-tag';

export default function dexSwapVolumeTimeseries(
  address: string,
  denom0: string,
  denom1: string
) {
  return sql`
    WITH
      dex_shares AS (
        SELECT
          -- sorting
          "timestamp",
          "height",
          "sort_key",
          (
            "event_index"        * toUInt256(1))
            + ("tx_index"         * toUInt256(4294967296))              -- + shift by 32 event_index bits (2^32)
            + ("block_part_index" * toUInt256(18446744073709551616))    -- + shift by 32 tx_index bits (2^64)
            + ("height"           * toUInt256(4722366482869645213696)
          ) as "version",
          -- user
          "Receiver",
          -- pool index
          "TokenZero",
          "TokenOne",
          "TickIndex",
          "Fee",
          -- values
          "user_shares",
          "total_shares"
        FROM spacebox.dex_shares_by_pool_agg
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
          (
            "event_index"        * toUInt256(1))
            + ("tx_index"         * toUInt256(4294967296))              -- + shift by 32 event_index bits (2^32)
            + ("block_part_index" * toUInt256(18446744073709551616))    -- + shift by 32 tx_index bits (2^64)
            + ("height"           * toUInt256(4722366482869645213696)
          ) as "version",
          -- pool index
          "TokenZero",
          "TokenOne",
          "TickIndex",
          "Fee",
          -- get swap volume+fees in token in units
          "ReservesInZero",
          "ReservesInOne",
          -- fee basis is 1 point = 0.001%
          "ReservesInZero" * "Fee" / 100000 as "FeesZero",
          "ReservesInOne" * "Fee" / 100000 as "FeesOne",
          -- mark if this is active or passive volume
          "action" != 'TickUpdate' as "active"
        FROM spacebox.dex_swaps
        -- ensure no double counting
        FINAL
        -- filter data early to reduce processing
        WHERE
          -- filter to pair
          "TokenZero" = ${denom0} AND
          "TokenOne" = ${denom1} AND
          -- do not include tranches (limit order liquidity)
          "TrancheKey" IS NULL
      ),
      swaps_with_shares AS (
        SELECT
          swap."timestamp" as "timestamp",
          swap."height" as "height",
          swap."sort_key" as "sort_key",
          -- pool index
          swap."TokenZero" as "TokenZero",
          swap."TokenOne" as "TokenOne",
          swap."TickIndex" as "TickIndex",
          swap."Fee" as "Fee",
          -- values
          swap."ReservesInZero" as "ReservesInZero",
          swap."ReservesInOne" as "ReservesInOne",
          swap."FeesZero" as "FeesZero",
          swap."FeesOne" as "FeesOne",
          swap."active" as "active",
          COALESCE(user_shares."user_shares", 0) as "user_shares",
          COALESCE(dex_shares."total_shares", 0) as "total_shares"
        FROM dex_volumes as swap
        -- join to closest available user_shares
        ASOF LEFT JOIN dex_shares as user_shares
          ON dex_shares."TokenZero" = swap."TokenZero"
          AND dex_shares."TokenOne" = swap."TokenOne"
          AND dex_shares."TickIndex" = swap."TickIndex"
          AND dex_shares."Fee" = swap."Fee"
          AND dex_shares."Receiver" = ${address} -- <-- get user's last shares
          AND dex_shares."version" <= swap."version"
        -- join to closest available total_shares
        ASOF LEFT JOIN dex_shares
          ON dex_shares."TokenZero" = swap."TokenZero"
          AND dex_shares."TokenOne" = swap."TokenOne"
          AND dex_shares."TickIndex" = swap."TickIndex"
          AND dex_shares."Fee" = swap."Fee"
          AND dex_shares."version" <= swap."version"
        ),
    "user_shares" / "total_shares" as "user_fraction"
    SELECT
      "timestamp",
      "height",
      -- pool index
      "TokenZero",
      "TokenOne",
      "TickIndex",
      "Fee",
      -- values
      "user_fraction" * toFloat64("ReservesInZero") as "volume_zero",
      "user_fraction" * toFloat64("ReservesInOne") as "volume_one",
      "user_fraction" * "FeesZero" as "fees_zero",
      "user_fraction" * "FeesOne" as "fees_one",
      "active"
    FROM swaps_with_shares
    WHERE "user_shares" > 0
  `;
}
