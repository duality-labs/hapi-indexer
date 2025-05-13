import sql from 'sql-template-tag';

export interface VaultResponse {
  height: string;
  created_at: string;
  updated_at: string;
  contract_address: string;
  owner: string[];
  token_a_denom: string;
  token_a_decimals: number;
  token_a_symbol: string;
  token_a_quote_currency: string;
  token_a_max_blocks_stale: string;
  token_b_denom: string;
  token_b_decimals: number;
  token_b_symbol: string;
  token_b_quote_currency: string;
  token_b_max_blocks_stale: string;
  token_order: string[];
  pool_id: string;
  deposit_cap: string;
  oracle_contract: string;
  imbalance: string;
  fee_tier_config: string;
  timestamp_stale: string;
  paused: boolean;
  denom: string;
}

// this select statement applies the "swap volume fix" to recreate
// SwapAmountIn/SwapAmountOut for events in Neutron <= v5 that do not have them
export const selectVaultConfigs = sql`
    WITH
        event_with_maybe_related_contract_attributes AS (
            SELECT
                argMax(initial."timestamp", initial."height") as "created_at",
                argMax(updated."timestamp", updated."height") as "updated_at",
                argMax(updated."height", updated."height") as "height",
                argMax(updated."txhash", updated."height") as "txhash",
                argMax(updated."event_index", updated."height") as "event_index",
                "contract_address",
                flatten(
                    arrayMap(
                        -- return attributes
                        (tuple) -> JSONExtractArrayRaw(tuple.3),
                        arraySort(
                            -- sort by height descending (most recent updates first)
                            (tuple) -> -tuple.1,
                            arrayFirst(
                                -- return only array of events that includes a 'create_token' event
                                (tuples) -> arrayExists(
                                    tuple -> tuple.2 = 'create_token',
                                    tuples
                                ),
                                [groupArray((updated."height", updated."action", updated."attributes"))]
                            )
                        )
                    )
                ) as "contract_attributes"
            FROM spacebox.dex_vaults_config_tx_event as initial
            INNER JOIN spacebox.dex_vaults_config_tx_event as updated
                ON (initial."contract_address" = updated."contract_address")
            -- start with initial vault creation event
            WHERE initial."action" = 'instantiate IMM'
            GROUP BY "contract_address"
        ),
        event_with_related_contract_attributes AS (
            SELECT *
            FROM event_with_maybe_related_contract_attributes
            WHERE notEmpty("contract_attributes")
        ),
        vault_configs AS (
            SELECT
                "height",
                "created_at",
                "updated_at",
                "txhash",
                "event_index",
                "contract_address",
                -- add event attributes
                arrayMap(
                    (matches) -> arrayFirst((match) -> notEmpty(match), matches),
                    extractAllGroupsVertical(
                        JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'owner'), "contract_attributes"), 'value'),
                        'Addr\(\"([a-z]+[a-z0-9]{30,})"\)'
                    )
                ) AS "owner",
                -- support incorrectly named "max_blocks_stale_token_a" and "max_blocks_stale_token_b" attributes
                toUInt64OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'max_blocks_stale_token_a'), "contract_attributes"), 'value')) AS "max_blocks_stale_token_a",
                toUInt64OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'max_blocks_stale_token_b'), "contract_attributes"), 'value')) AS "max_blocks_stale_token_b",
                toUInt64OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'max_blocks_stale_token_0'), "contract_attributes"), 'value')) AS "max_blocks_stale_token_0",
                toUInt64OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'max_blocks_stale_token_1'), "contract_attributes"), 'value')) AS "max_blocks_stale_token_1",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_0_denom'), "contract_attributes"), 'value') AS "token_0_denom",
                toUInt8OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_0_decimals'), "contract_attributes"), 'value')) AS "token_0_decimals",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_0_symbol'), "contract_attributes"), 'value') AS "token_0_symbol",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_0_quote_currency'), "contract_attributes"), 'value') AS "token_0_quote_currency",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_1_denom'), "contract_attributes"), 'value') AS "token_1_denom",
                toUInt8OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_1_decimals'), "contract_attributes"), 'value')) AS "token_1_decimals",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_1_symbol'), "contract_attributes"), 'value') AS "token_1_symbol",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'token_1_quote_currency'), "contract_attributes"), 'value') AS "token_1_quote_currency",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'pool_id'), "contract_attributes"), 'value') AS "pool_id",
                toUInt256OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'deposit_cap'), "contract_attributes"), 'value')) AS "deposit_cap",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'oracle_contract'), "contract_attributes"), 'value') AS "oracle_contract",
                toUInt64OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'imbalance'), "contract_attributes"), 'value')) AS "imbalance",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'fee_tier_config'), "contract_attributes"), 'value') AS "fee_tier_config",
                toUInt64OrZero(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'timestamp_stale'), "contract_attributes"), 'value')) AS "timestamp_stale",
                toBool(JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'paused'), "contract_attributes"), 'value')) AS "paused",
                JSONExtractString(arrayFirst(x -> (JSONExtractString(x, 'key') = 'denom'), "contract_attributes"), 'value') AS "denom",
                extractGroups("denom", 'factory\/[a-z0-9]{30,}\/([A-Z]+)-([A-Z]+)') AS estimated_token_order
            FROM event_with_related_contract_attributes
            WHERE notEmpty("denom")
        ),
        -- fill in missing values with defaults
        filled_vault_configs as (
            SELECT *,
                if(
                    "token_0_decimals" > 0,
                    "token_0_decimals",
                    if (
                        "token_0_symbol" in ('ETH', 'DYDX'),
                        18,
                        if (
                            "token_0_symbol" = 'BTC',
                            8,
                            6
                        )
                    )
                ) as "token_0_decimals",
                if(
                    "token_1_decimals" > 0,
                    "token_1_decimals",
                    if (
                        "token_1_symbol" in ('ETH', 'DYDX'),
                        18,
                        if (
                            "token_1_symbol" = 'BTC',
                            8,
                            6
                        )
                    )
                ) as "token_1_decimals"
            FROM vault_configs
        )
    -- finally normalize the data to the correct side
    SELECT
        *,
        "height",
        "created_at",
        "updated_at",
        "contract_address",
        "owner",
        "token_0_denom",
        "token_0_decimals",
        "token_0_symbol",
        "token_0_quote_currency",
        -- support incorrectly named "max_blocks_stale_token_a" attributes
        -- these mean "max_blocks_stale_token_0"
        if(
            "max_blocks_stale_token_0" > 0,
            "max_blocks_stale_token_0",
            "max_blocks_stale_token_a"
        ) as "token_0_max_blocks_stale",
        "token_1_denom",
        "token_1_decimals",
        "token_1_symbol",
        "token_1_quote_currency",
        -- support incorrectly named "max_blocks_stale_token_b" attributes
        -- these mean "max_blocks_stale_token_1"
        if(
            "max_blocks_stale_token_1" > 0,
            "max_blocks_stale_token_1",
            "max_blocks_stale_token_b"
        ) as "token_1_max_blocks_stale",
        -- add estimated order from contract denom string to end users
        arrayFilter(
            (denom) -> notEmpty(denom),
            arrayMap(
                -- convert from symbol to denom
                (symbol) -> (
                    if (
                        symbol = "token_0_symbol",
                        "token_0_denom",
                        if (
                            symbol = "token_1_symbol",
                            "token_1_denom",
                            ''
                        )
                    )
                ),
                "estimated_token_order"
            )
        ) as "estimated_token_order",
        "pool_id",
        "deposit_cap",
        "oracle_contract",
        "imbalance",
        "fee_tier_config",
        "timestamp_stale",
        "paused",
        "denom"
    FROM filled_vault_configs
`;
