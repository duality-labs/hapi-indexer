
/*
  * setup events tables for specific events
  * these are key values form the event attributes
  * in 'tx_result.events'.'attributes' as JSON blobs
  */
CREATE TABLE 'event.TickUpdate' (
  'block.header.height' INTEGER NOT NULL,
  'block.header.time_unix' INTEGER NOT NULL,
  'tx.index' INTEGER NOT NULL,
  'tx_result.events.index' INTEGER NOT NULL,

  'Token0' TEXT NOT NULL,
  'Token1' TEXT NOT NULL,
  'TokenIn' TEXT NOT NULL,
  'TickIndex' INTEGER NOT NULL,
  'Reserves' TEXT NOT NULL,

  'meta.dex.pair' INTEGER NOT NULL,
  'meta.dex.token' INTEGER NOT NULL,

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
    'dex.pairs'('id'),

  FOREIGN KEY
    ('meta.dex.token')
  REFERENCES
    'dex.tokens'('id')
);

/* add unique index constraint */
CREATE UNIQUE INDEX
  'event.TickUpdate--block.header.height,tx.index,tx_result.events.index'
ON
  'event.TickUpdate' (
    'block.header.height',
    'tx.index',
    'tx_result.events.index'
  );

/* add index for timeseries lookups, ie. lookup by pair id and then time */
CREATE INDEX
  'event.TickUpdate--meta.dex.pair,block.header.time_unix'
ON
  'event.TickUpdate' (
    'meta.dex.pair',
    'block.header.time_unix'
  );
