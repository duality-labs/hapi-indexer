
/*
  * setup events tables for specific events
  * these are key values form the event attributes
  * in 'tx_result.events'.'attributes' as JSON blobs
  */
CREATE TABLE 'event.Withdraw' (
  'block.header.height' INTEGER NOT NULL,
  'block.header.time_unix' INTEGER NOT NULL,
  'tx.index' INTEGER NOT NULL,
  'tx_result.events.index' INTEGER NOT NULL,

  'Creator' TEXT NOT NULL,
  'Receiver' TEXT NOT NULL,
  'Token0' TEXT NOT NULL,
  'Token1' TEXT NOT NULL,
  'TickIndex' INTEGER NOT NULL,
  'Fee' INTEGER NOT NULL,
  'Reserves0Withdrawn' TEXT NOT NULL,
  'Reserves1Withdrawn' TEXT NOT NULL,
  'SharesRemoved' TEXT NOT NULL,

  'related.dex.pair' INTEGER NOT NULL,

  FOREIGN KEY ('block.header.height')
    REFERENCES 'block'('header.height'),

  FOREIGN KEY ('block.header.time_unix')
    REFERENCES 'block'('header.time_unix'),

  FOREIGN KEY ('tx.index')
    REFERENCES 'tx'('index'),

  FOREIGN KEY ('tx_result.events.index')
    REFERENCES 'tx_result.events'('index'),

  FOREIGN KEY ('related.dex.pair')
    REFERENCES 'dex.pairs'('id')
);

/* add unique index constraint */
CREATE UNIQUE INDEX
  'event.Withdraw--block.header.height,tx.index,tx_result.events.index'
ON
  'event.Withdraw' (
    'block.header.height',
    'tx.index',
    'tx_result.events.index'
  );
