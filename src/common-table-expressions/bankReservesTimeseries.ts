import sql from 'sql-template-tag';
import bankReservesDeltasTimeseries from './bankReservesDeltas';

export default function bankReservesTimeseries(
  address: string,
  denom0: string,
  denom1: string
) {
  return sql`
    WITH
      bank_balance_deltas_union AS (${bankReservesDeltasTimeseries(
        address,
        denom0,
        denom1
      )})
    SELECT
      "timestamp",
      "height",
      "sort_key",
      -- pool index
      "TokenZero",
      "TokenOne",
      "TokenIn",
      -- values
      sum("balance_delta") OVER cumulative_events as "address_balance"
    FROM bank_balance_deltas_union
    WINDOW cumulative_events AS (
      -- partition sums to each pool
      PARTITION BY "TokenZero", "TokenOne", "TokenIn"
      ORDER BY "sort_key" ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )
  `;
}
