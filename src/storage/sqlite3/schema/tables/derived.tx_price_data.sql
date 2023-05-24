
/*
  * add derived data from tick update data to know the state of
  * all price data throughout time
  */
CREATE TABLE 'derived.tx_price_data' (
  'block.header.height' INTEGER NOT NULL,
  'block.header.time_unix' INTEGER NOT NULL,
  'tx.index' INTEGER NOT NULL,
  'tx_result.events.index' INTEGER NOT NULL,

  'meta.dex.pair' INTEGER NOT NULL,

  'HighestTick0' INTEGER,
  'LowestTick1' INTEGER,
  'LastTick' INTEGER NOT NULL,

  FOREIGN KEY
    ('block.header.height')
  REFERENCES
    'block'('header.height'),

  FOREIGN KEY
    ('block.header.time_unix')
  REFERENCES
    'block'('header.time_unix'),

  FOREIGN KEY
    ('tx.index')
  REFERENCES
    'tx'('index'),

  FOREIGN KEY
    ('tx_result.events.index')
  REFERENCES
    'tx_result.events'('index'),

  FOREIGN KEY
    ('meta.dex.pair')
  REFERENCES
    'dex.pairs'('id')
);

/* add unique index constraint */
CREATE UNIQUE INDEX
  'derived.tx_price_data--block.header.height,tx.index,tx_result.events.index'
ON
  'derived.tx_price_data' (
    'block.header.height',
    'tx.index',
    'tx_result.events.index'
  );

/* add index for timeseries lookups, ie. lookup by pair id and then time */
CREATE INDEX
  'derived.tx_price_data--meta.dex.pair,block.header.time_unix'
ON
  'derived.tx_price_data' (
    'meta.dex.pair',
    'block.header.time_unix'
  );
