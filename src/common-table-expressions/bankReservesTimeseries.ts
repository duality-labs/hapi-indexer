import sql from 'sql-template-tag';

export default function bankReservesTimeseries(
  address: string,
  denom0: string,
  denom1: string
) {
  return sql`
    WITH
      bank_balance_token_zero_deltas AS (
        SELECT
          "timestamp",
          "height",
          "sort_key",
          -- pool index
          ${denom0} as "TokenZero",
          ${denom1} as "TokenOne",
          -- choose side as TokenZero
          "TokenZero" as "TokenIn",
          -- Reserves
          "amount" AS "BalanceDelta"
        FROM spacebox.bank_transfer
        WHERE "address" = ${address}
          AND "denom" = ${denom0}
      ),
      bank_balance_token_one_deltas AS (
        SELECT
          "timestamp",
          "height",
          "sort_key",
          -- pool index
          ${denom0} as "TokenZero",
          ${denom1} as "TokenOne",
          -- choose side as TokenOne
          "TokenOne" as "TokenIn",
          -- Reserves
          "amount" AS "BalanceDelta"
        FROM spacebox.bank_transfer
        WHERE "address" = ${address}
          AND "denom" = ${denom1}
      ),
      bank_balance_deltas_union AS (
        SELECT * FROM bank_balance_token_zero_deltas
        UNION ALL
        SELECT * FROM bank_balance_token_one_deltas
      )
    SELECT
      "timestamp",
      "height",
      "sort_key",
      -- pool index
      "TokenZero",
      "TokenOne",
      "TokenIn",
      -- values
      sum("BalanceDelta") OVER cumulative_events as "address_balance"
    FROM bank_balance_deltas_union
    WINDOW cumulative_events AS (
      -- partition sums to each pool
      PARTITION BY "TokenZero", "TokenOne", "TokenIn"
      ORDER BY "sort_key" ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )
  `;
}
