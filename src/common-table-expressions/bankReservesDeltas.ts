import sql from 'sql-template-tag';

export default function bankReservesDeltasTimeseries(
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
          -- remove coins_index from sort key (no longer needed)
          ("sort_key".1, "sort_key".2, "sort_key".3, "sort_key".4) as "sort_key",
          -- pool index
          ${denom0} as "TokenZero",
          ${denom1} as "TokenOne",
          -- choose side as TokenZero
          "TokenZero" as "TokenIn",
          -- Reserves
          "amount" AS "balance_delta"
        FROM spacebox.bank_transfer
        WHERE "address" = ${address}
          AND "denom" = ${denom0}
      ),
      bank_balance_token_one_deltas AS (
        SELECT
          "timestamp",
          "height",
          -- remove coins_index from sort key (no longer needed)
          ("sort_key".1, "sort_key".2, "sort_key".3, "sort_key".4) as "sort_key",
          -- pool index
          ${denom0} as "TokenZero",
          ${denom1} as "TokenOne",
          -- choose side as TokenOne
          "TokenOne" as "TokenIn",
          -- Reserves
          "amount" AS "balance_delta"
        FROM spacebox.bank_transfer
        WHERE "address" = ${address}
          AND "denom" = ${denom1}
      )
      SELECT * FROM bank_balance_token_zero_deltas
      UNION ALL
      SELECT * FROM bank_balance_token_one_deltas
  `;
}
