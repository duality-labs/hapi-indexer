
/*
  * add derived data from tick update data to know the state of
  * all volume data throughout time
  */
CREATE TABLE 'derived.tx_volume_data' (

  'ReservesFloat0' REAL NOT NULL DEFAULT 0,
  'ReservesFloat1' REAL NOT NULL DEFAULT 0,

  'related.block' INTEGER NOT NULL,
  'related.tx' INTEGER NOT NULL,
  'related.tx_result.events' INTEGER NOT NULL,
  'related.dex.pair' INTEGER NOT NULL,

  FOREIGN KEY ('related.block')
    REFERENCES 'block'('id'),

  FOREIGN KEY ('related.tx')
    REFERENCES 'tx'('id'),

  FOREIGN KEY ('related.tx_result.events')
    REFERENCES 'tx_result.events'('id'),

  FOREIGN KEY ('related.dex.pair')
    REFERENCES 'dex.pairs'('id')
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
  'derived.tx_volume_data--related.dex.pair,related.block'
ON
  'derived.tx_volume_data' (
    'related.dex.pair',
    'related.block'
  );
