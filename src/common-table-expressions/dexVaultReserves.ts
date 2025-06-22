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
        -- note: fix difference between intended and actual balance later
        --       intended balance does not account for "swap on deposit"
        --       or failed deposit events: the intended balance will be 100%
        --       of the vault's available tokens, but actual value may differ
        if ("TokenIn" = "TokenZero", "token_0_balance_before_deposit", "token_1_balance_before_deposit") as "Reserves"
      FROM spacebox.dex_vaults_dex_balance
      ARRAY JOIN [${denom0}, ${denom1}] as "TokenIn"
      -- filter data early to reduce processing
      WHERE
        -- filter to vault
        "contract_address" = ${address}
  `;
}
