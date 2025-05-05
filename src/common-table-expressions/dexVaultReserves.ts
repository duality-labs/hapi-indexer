import sql from 'sql-template-tag';

export default function dexVaultReservesTimeseries(
  address: string,
  denom0: string,
  denom1: string
) {
  return sql`
      WITH
        ${denom0} as "TokenZero",
        ${denom1} as "TokenOne"
      SELECT
        -- sorting
        "timestamp",
        "height",
        "block_part_index",
        "tx_index",
        "event_index",
        "sort_key",
        "TokenZero",
        "TokenOne",
        "TokenIn",
        -- values
        if ("TokenIn" = "TokenZero", "token_0_balance", "token_1_balance") as "Reserves"
      FROM spacebox.dex_vaults_dex_balance
      ARRAY JOIN [${denom0}, ${denom1}] as "TokenIn"
      -- filter data early to reduce processing
      WHERE
        -- filter to vault
        "contract_address" = ${address}
  `;
}
