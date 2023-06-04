
/*
  * setup events tables for specific events
  * these are key values form the event attributes
  * in 'tx_result.events'.'attributes' as JSON blobs
  */
CREATE TABLE 'event.TickUpdate' (

  'Token0' TEXT NOT NULL,
  'Token1' TEXT NOT NULL,
  'TokenIn' TEXT NOT NULL,
  'TickIndex' INTEGER NOT NULL,
  'Reserves' TEXT NOT NULL,

  'related.tx_result.events' INTEGER NOT NULL,
  'related.dex.pair' INTEGER NOT NULL,
  'related.dex.token' INTEGER NOT NULL,

  FOREIGN KEY ('related.tx_result.events')
    REFERENCES 'tx_result.events'('id'),

  FOREIGN KEY ('related.dex.pair')
    REFERENCES 'dex.pairs'('id'),

  FOREIGN KEY ('related.dex.token')
    REFERENCES 'dex.tokens'('id')
);

/* add unique index constraint */
CREATE UNIQUE INDEX
  'event.TickUpdate--related.tx_result.events'
ON
  'event.TickUpdate' (
    'related.tx_result.events'
  );

/* add index for timeseries lookups, ie. lookup by pair id and then time */
CREATE INDEX
  'event.TickUpdate--related.dex.pair,related.tx_result.events'
ON
  'event.TickUpdate' (
    'related.dex.pair',
    'related.tx_result.events'
  );
