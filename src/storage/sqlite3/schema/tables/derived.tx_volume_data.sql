
/*
  * add derived data from tick update data to know the state of
  * all volume data throughout time
  */
CREATE TABLE 'derived.tx_volume_data' (

  'ReservesFloat0' REAL NOT NULL DEFAULT 0,
  'ReservesFloat1' REAL NOT NULL DEFAULT 0,

  'related.tx_result.events' INTEGER NOT NULL,
  'related.dex.pair' INTEGER NOT NULL,
  'related.block.header.height' INTEGER NOT NULL,

  FOREIGN KEY ('related.tx_result.events')
    REFERENCES 'tx_result.events'('id'),

  FOREIGN KEY ('related.dex.pair')
    REFERENCES 'dex.pairs'('id'),

  FOREIGN KEY ('related.block.header.height')
    REFERENCES 'block'('header.height')
);

/* add unique index constraint */
CREATE UNIQUE INDEX
  'derived.tx_volume_data--related.tx_result.events'
ON
  'derived.tx_volume_data' (
    'related.tx_result.events'
  );

/* add index for timeseries lookups, ie. lookup by pair id and then time */
CREATE INDEX
  'derived.tx_volume_data--related.dex.pair,related.tx_result.events'
ON
  'derived.tx_volume_data' (
    'related.dex.pair',
    'related.tx_result.events'
  );

/* add index for quicker lookups filtering to block height */
CREATE INDEX
  'derived.tx_volume_data--related.block.header.height'
ON
  'derived.tx_volume_data' (
    'related.block.header.height'
  );
