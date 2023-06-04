
/*
  * setup events tables for specific events
  * these are key values form the event attributes
  * in 'tx_result.events'.'attributes' as JSON blobs
  */
CREATE TABLE 'event.Withdraw' (
  'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,

  'Creator' TEXT NOT NULL,
  'Receiver' TEXT NOT NULL,
  'Token0' TEXT NOT NULL,
  'Token1' TEXT NOT NULL,
  'TickIndex' INTEGER NOT NULL,
  'Fee' INTEGER NOT NULL,
  'Reserves0Withdrawn' TEXT NOT NULL,
  'Reserves1Withdrawn' TEXT NOT NULL,
  'SharesRemoved' TEXT NOT NULL,

  'related.tx_result.events' INTEGER NOT NULL,
  'related.dex.pair' INTEGER NOT NULL,

  FOREIGN KEY ('related.tx_result.events')
    REFERENCES 'tx_result.events'('id'),

  FOREIGN KEY ('related.dex.pair')
    REFERENCES 'dex.pairs'('id')
);

/* add unique index constraint */
CREATE UNIQUE INDEX
  'event.Withdraw--related.tx_result.events'
ON
  'event.Withdraw' (
    'related.tx_result.events'
  );
