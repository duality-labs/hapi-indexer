
/*
  * add derived data from tick update data to know the state of
  * all price data throughout time
  */
CREATE TABLE 'derived.tx_price_data' (

  -- last tick index that a trade happened on
  'LastTickIndex1To0' INTEGER NOT NULL,

  'related.tx_result.events' INTEGER NOT NULL,
  'related.dex.pair' INTEGER NOT NULL,

  FOREIGN KEY ('related.tx_result.events')
    REFERENCES 'tx_result.events'('id'),

  FOREIGN KEY ('related.dex.pair')
    REFERENCES 'dex.pairs'('id')
);

/* add unique index constraint */
CREATE UNIQUE INDEX
  'derived.tx_price_data--related.tx_result.events'
ON
  'derived.tx_price_data' (
    'related.tx_result.events'
  );

/* add index for timeseries lookups, ie. lookup by pair id and then time */
CREATE INDEX
  'derived.tx_price_data--related.dex.pair,related.tx_result.events'
ON
  'derived.tx_price_data' (
    'related.dex.pair',
    'related.tx_result.events'
  );
