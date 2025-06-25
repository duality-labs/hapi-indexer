WITH RECURSIVE recursive_calc AS (
  -- First row (anchor row)
  SELECT
      contract_address, block_timestamp, block_height, tx_hash, tx_index, message_index, action_index, 
      action, token_0_action_amount, token_1_action_amount, shares_action_amount, shares_total, 
      token0_value,
      token1_value,
      token0_vault_value,
      token1_vault_value,
      token0_usd_value,
      token1_usd_value,
      token0_price,
      token1_price,
      rn,
      CASE
          WHEN action = 'instantiate' THEN 0.0
          WHEN action = 'deposit' and token0_price != 0 THEN 
            (
              -- get value of token 0
              (token_0_action_amount / (CASE WHEN token0Ticker = "BTC" THEN 1e8  
                    WHEN token0Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * token0_price)
              -- get value of token 1
              + (token_1_action_amount / (CASE WHEN token1Ticker = "BTC" THEN 1e8  
                    WHEN token1Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * token1_price)
            ) / 2.0 / (1.0 * token0_price)
          WHEN action = 'withdrawal' and shares_total !=0 THEN 0 ELSE NULL
      END AS token0_vault, -- <-- half the value of the vault as Token0

      CASE
          WHEN action = 'instantiate' THEN 0.0
          WHEN action = 'deposit' and token1_price != 0 THEN 
            (
              -- get value of token 0
              (token_0_action_amount / (CASE WHEN token0Ticker = "BTC" THEN 1e8  
                    WHEN token0Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * token0_price) 
              -- get value of token 1
              + (token_1_action_amount / (CASE WHEN token1Ticker = "BTC" THEN 1e8  
                    WHEN token1Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * token1_price)
            ) / 2.0 / (1.0 * token1_price)
          WHEN action = 'withdrawal' and shares_total !=0 THEN 0 ELSE NULL
      END AS token1_vault -- <-- half the value of the vault as Token1

  FROM ordered_log -- <-- timeline of vault 'instantiate', 'deposit', and 'withdrawal' actions
  WHERE rn = 1

  UNION ALL

  -- Recursive step
  SELECT
      o.contract_address,
      o.block_timestamp,
      o.block_height, o.tx_hash, o.tx_index, o.message_index, o.action_index,
      o.action, o.token_0_action_amount, o.token_1_action_amount, o.shares_action_amount, o.shares_total, 
      o.token0_value,
      o.token1_value,
      o.token0_vault_value,
      o.token1_vault_value,
      o.token0_usd_value,
      o.token1_usd_value,
      o.token0_price,
      o.token1_price,
      o.rn,

      CASE
          WHEN o.action = 'instantiate' THEN r.token0_vault
          WHEN o.action = 'deposit' THEN r.token0_vault + (
              (CAST(o.token_0_action_amount AS BIGNUMERIC) / (CASE WHEN o.token0Ticker = "BTC" THEN 1e8  
                    WHEN o.token0Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * o.token0_price) 
              + (CAST(o.token_1_action_amount AS BIGNUMERIC) / (CASE WHEN o.token1Ticker = "BTC" THEN 1e8  
                    WHEN o.token1Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * o.token1_price)
            ) / 2.0 / (1.0 * o.token0_price)

          WHEN o.action = 'withdrawal' THEN 
              CASE 
                WHEN o.shares_total !=0 THEN r.token0_vault * (o.shares_action_amount / (o.shares_total+o.shares_action_amount)) -- <-- on withdrawal amount of vault token 0 becomes the withdrawal amount value?
                ELSE 0
              END
      END AS token0_vault,

      CASE
          WHEN o.action = 'instantiate' THEN r.token1_vault
          WHEN o.action = 'deposit' THEN r.token1_vault + (
              (CAST(o.token_0_action_amount AS BIGNUMERIC) / (CASE WHEN o.token0Ticker = "BTC" THEN 1e8  
                    WHEN o.token0Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * o.token0_price) 
              + (CAST(o.token_1_action_amount AS BIGNUMERIC) / (CASE WHEN o.token1Ticker = "BTC" THEN 1e8  
                    WHEN o.token1Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * o.token1_price)
            ) / 2.0 / (1.0 * o.token1_price)

          WHEN o.action = 'withdrawal' THEN 
              CASE 
                WHEN o.shares_total !=0 THEN r.token1_vault * (o.shares_action_amount / (o.shares_total+o.shares_action_amount))
                ELSE 0
              END
      END AS token1_vault
  FROM ordered_log o
  JOIN recursive_calc r
    ON o.contract_address = r.contract_address
   AND o.rn = r.rn + 1
),


--# all current available denoms for tokens (could be updated)
denoms AS (
    SELECT "untrn" AS denom, "NTRN" AS token_name, "NTRN" as slinky_ticker UNION ALL
    SELECT "ibc/DF8722298D192AAB85D86D0462E8166234A6A9A572DD4A2EA7996029DF4DB363", "WBTC", "BTC" UNION ALL
    SELECT "ibc/773B4D0A3CD667B2275D5A4A7A2F0909C0BA0F4059C0B9181E680DDF4965DCC7", "TIA", "TIA" UNION ALL
    SELECT "ibc/C4CFF46FD6DE35CA4CF4CE031E643C8FDC9BA4B99AE598E9B0ED98FE3A2319F9", "ATOM", "ATOM" UNION ALL
    SELECT "ibc/B559A80D62249C8AA07A380E2A2BEA6E5CA9A6F079C912C3A9E9B494105E4F81", "USDC", "USDC" UNION ALL
    SELECT "ibc/2CB87BCE0937B1D1DFCEE79BE4501AAF3C265E923509AEAC410AD85D27F35130", "DYDX", "DYDX"  UNION ALL
    SELECT "ibc/376222D6D9DAE23092E29740E56B758580935A6D77C24C2ABD57A6A78A1F3955", "OSMO", "OSMO" UNION ALL
    SELECT "ibc/A585C2D15DCD3B010849B453A2CFCB5E213208A5AB665691792684C26274304D", "WETH", "ETH" UNION ALL
    SELECT "factory/neutron1frc0p5czd9uaaymdkug2njz7dc7j65jxukp9apmt9260a8egujkspms2t2/udntrn", "dNTRN", "NTRN" UNION ALL
    SELECT "factory/neutron1k6hr0f83e7un2wjf29cspk7j69jrnskk65k3ek2nj9dztrlzpj6q00rtsa/udatom", "dATOM", "ATOM" UNION ALL
    SELECT "factory/neutron1ut4c6pv4u6vyu97yw48y8g7mle0cat54848v6m97k977022lzxtsaqsgmq/udtia", "dTIA", "TIA"
),

--# all vaults instantiate events 
vaults as (
  SELECT 
    block_height,
    block_timestamp,
    json_value(event_attributes, "$._contract_address") as contract_address, 
  coalesce(d_0.token_name, json_value(event_attributes, "$.token_0_denom")) as token0,
  coalesce(d_1.token_name, json_value(event_attributes, "$.token_1_denom")) as token1,
  d_0.slinky_ticker as token0Ticker,
  d_1.slinky_ticker as token1Ticker,
  block_timestamp as instantiate_timestamp,
  concat(d_0.slinky_ticker, "/USD") as  token0_pair,
  concat(d_1.slinky_ticker, "/USD") as  token1_pair,
  concat(coalesce(d_0.token_name, json_value(event_attributes, "$.token_0_denom")), '<>',
  coalesce(d_1.token_name, json_value(event_attributes, "$.token_1_denom"))
  ) as token_pair,
  concat(d_0.slinky_ticker, '<>', d_1.slinky_ticker) as slinky_pair

  FROM `numia-data.neutron.neutron_message_events` 
  left join denoms as d_0 on json_value(event_attributes, "$.token_0_denom") = d_0.denom
  left join denoms as d_1 on json_value(event_attributes, "$.token_1_denom") = d_1.denom

  WHERE 
    json_value(event_attributes, "$.action") = "instantiate IMM"
    -- and date(block_timestamp) >= '2025-04-22'
),

--# instantiate, user_deposit, user withdrawal events
event_data_table as (
  SELECT
    events.block_timestamp, events.block_height, events.tx_hash, events.tx_index, events.message_index, events.action_index,   
    events.contract_address,
    events.action,
    CAST(token_0_action_amount AS BIGNUMERIC) as token_0_action_amount,
    CAST(token_1_action_amount AS BIGNUMERIC) as token_1_action_amount,
    CAST(shares_action_amount AS BIGNUMERIC) as shares_action_amount,
    CAST(shares_total AS BIGNUMERIC) as shares_total,

    CAST(token_0_action_amount AS BIGNUMERIC) / (CASE WHEN token0Ticker = "BTC" THEN 1e8  
                    WHEN token0Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) as token0_value,

    CAST(token_1_action_amount AS BIGNUMERIC) / (CASE WHEN token1Ticker = "BTC" THEN 1e8  
                    WHEN token1Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) as token1_value,

    ((CAST(token_0_action_amount AS BIGNUMERIC) / (CASE WHEN token0Ticker = "BTC" THEN 1e8  
                    WHEN token0Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * slinky0.price / pow(10, slinky0.decimals)) 
              + (CAST(token_1_action_amount AS BIGNUMERIC) / (CASE WHEN token1Ticker = "BTC" THEN 1e8  
                    WHEN token1Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * slinky1.price / pow(10, slinky1.decimals))
            ) / 2.0 / (1.0 * slinky0.price / pow(10, slinky0.decimals)) as token0_vault_value,

    ((CAST(token_0_action_amount AS BIGNUMERIC) / (CASE WHEN token0Ticker = "BTC" THEN 1e8  
                    WHEN token0Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * slinky0.price / pow(10, slinky0.decimals)) 
              + (CAST(token_1_action_amount AS BIGNUMERIC) / (CASE WHEN token1Ticker = "BTC" THEN 1e8  
                    WHEN token1Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * slinky1.price / pow(10, slinky1.decimals))
            ) / 2.0 / (1.0 * slinky1.price / pow(10, slinky1.decimals)) as token1_vault_value,

    CAST(token_0_action_amount AS BIGNUMERIC) / (CASE WHEN token0Ticker = "BTC" THEN 1e8  
                    WHEN token0Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * slinky0.price / pow(10, slinky0.decimals) as token0_usd_value,

    CAST(token_1_action_amount AS BIGNUMERIC) / (CASE WHEN token1Ticker = "BTC" THEN 1e8  
                    WHEN token1Ticker in ("DYDX", "ETH") THEN 1e18
                    ELSE 1e6
                END) * slinky1.price / pow(10, slinky1.decimals) as token1_usd_value,


    vaults.instantiate_timestamp,
    vaults.token0,
    vaults.token1,
    vaults.token0_pair,
    vaults.token1_pair,
    vaults.slinky_pair,
    vaults.token_pair,
    vaults.token0Ticker,
    vaults.token1Ticker,
    slinky0.price / pow(10, slinky0.decimals) as token0_price,
    slinky1.price / pow(10, slinky1.decimals) as token1_price

  FROM
  -- gather events into supervault event tables
  (
  SELECT
    block_timestamp, block_height, tx_hash, tx_index, message_index, action_index,
    contract_address,
    'deposit' as action,
    token_0_deposited as token_0_action_amount,
    token_1_deposited as token_1_action_amount,
    shares_minted as shares_action_amount,
    shares_total
  FROM
    `numia-data.neutron.neutron_supervault_user_deposit`

  UNION ALL

  SELECT
    block_timestamp, block_height, tx_hash, tx_index, message_index, action_index,
    contract_address,
    'withdrawal' as action,
    token_0_withdrawn as token_0_action_amount,
    token_1_withdrawn as token_1_action_amount,
    shares_burnt as shares_action_amount,
    shares_total
  FROM
    `numia-data.neutron.neutron_supervault_user_withdrawal`

  UNION ALL

  SELECT
    block_timestamp, block_height, tx_hash, tx_index, message_index, action_index,
    contract_address,
    'instantiate' as action,
    '0' as token_0_action_amount,
    '0' as token_1_action_amount,
    '0' as shares_action_amount,
    '0' as shares_total
  FROM
    `numia-data.neutron.neutron_supervault_instantiate`
  ) as events
  join vaults on events.contract_address = vaults.contract_address
  left join `numia-data.neutron.neutron_slinky_prices` as slinky0
    on events.block_height = slinky0.block_height AND concat(vaults.token0Ticker, "/USD") = slinky0.ticker
  left join `numia-data.neutron.neutron_slinky_prices` as slinky1
    on events.block_height = slinky1.block_height AND concat(vaults.token1Ticker, "/USD") = slinky1.ticker
  where
    date(vaults.block_timestamp) >= '2025-04-22'
),

ordered_log AS (
  SELECT 
    *,
    ROW_NUMBER() OVER (
      PARTITION BY contract_address 
      ORDER BY
         block_timestamp, block_height, tx_hash, tx_index, message_index, action_index
    ) AS rn
  FROM event_data_table
)


SELECT 
  r.*,
  r.token0_vault * r.token0_price as token0_vault_hold_usd,
  r.token1_vault * r.token1_price as token1_vault_hold_usd,
  r.token0_vault * r.token0_price + r.token1_vault * r.token1_price as token_vault_hold_value,
  v.slinky_pair,
  v.token0_pair,
  v.token1_pair,
  v.token0,
  v.token1
FROM recursive_calc r
left join vaults v on r.contract_address = v.contract_address
ORDER BY contract_address, block_timestamp, block_height, tx_hash, tx_index, message_index, action_index
;

