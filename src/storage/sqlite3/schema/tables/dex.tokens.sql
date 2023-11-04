
/* setup module foreign key indexes to be used first */
CREATE TABLE 'dex.tokens' (
  'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  'token' TEXT NOT NULL,

  -- add chain-registry fields to describe IBC tokens
  'chain_name' TEXT,
  'port_id' TEXT,
  'channel_id' TEXT,
  'base.denom' TEXT,
  'base.exponent': INTEGER,
  'display.denom' TEXT,
  'display.exponent': INTEGER,

  -- add found CoinGecko ID for price queries
  'coingecko_id' TEXT
);

/* ensure token combination is unique */
CREATE UNIQUE INDEX
  'dex.tokens--token'
ON
  'dex.tokens' (
    'token'
  );
