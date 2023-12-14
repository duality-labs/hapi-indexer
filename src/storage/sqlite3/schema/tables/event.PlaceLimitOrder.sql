
/*
  * setup events tables for specific events
  * these are key values form the event attributes
  * in 'tx_result.events'.'attributes' as JSON blobs
  */
CREATE TABLE 'event.PlaceLimitOrder' (
  'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,

  'Creator' TEXT NOT NULL,
  'Receiver' TEXT NOT NULL,
  'TokenZero' TEXT NOT NULL,
  'TokenOne' TEXT NOT NULL,
  'TokenIn' TEXT NOT NULL,
  'TokenOut' TEXT NOT NULL,
  'AmountIn' TEXT NOT NULL,
  'LimitTick' INTEGER NOT NULL,
  'OrderType' TEXT NOT NULL,
  'Shares' TEXT NOT NULL,
  'TrancheKey' TEXT NOT NULL,

  'related.tx_result.events' INTEGER NOT NULL,
  'related.dex.pair' INTEGER NOT NULL,
  'related.dex.tokenIn' INTEGER NOT NULL,
  'related.dex.tokenOut' INTEGER NOT NULL,

  FOREIGN KEY ('related.tx_result.events')
    REFERENCES 'tx_result.events'('id'),

  FOREIGN KEY ('related.dex.pair')
    REFERENCES 'dex.pairs'('id'),

  FOREIGN KEY ('related.dex.tokenIn')
    REFERENCES 'dex.tokens'('id'),

  FOREIGN KEY ('related.dex.tokenOut')
    REFERENCES 'dex.tokens'('id')
);

/* add unique index constraint */
CREATE UNIQUE INDEX
  'event.PlaceLimitOrder--related.tx_result.events'
ON
  'event.PlaceLimitOrder' (
    'related.tx_result.events'
  );
