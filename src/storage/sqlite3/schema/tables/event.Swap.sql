
/*
  * setup events tables for specific events
  * these are key values form the event attributes
  * in 'tx_result.events'.'attributes' as JSON blobs
  */
CREATE TABLE 'event.Swap' (
  'block.header.height' INTEGER NOT NULL,
  'block.header.time_unix' INTEGER NOT NULL,
  'tx.index' INTEGER NOT NULL,
  'tx_result.events.index' INTEGER NOT NULL,

  'Creator' TEXT NOT NULL,
  'Receiver' TEXT NOT NULL,
  'Token0' TEXT NOT NULL,
  'Token1' TEXT NOT NULL,
  'TokenIn' TEXT NOT NULL,
  'TokenOut' TEXT NOT NULL,
  'AmountIn' TEXT NOT NULL,
  'AmountOut' TEXT NOT NULL,

  'meta.dex.pair' INTEGER NOT NULL,
  'meta.dex.tokenIn' INTEGER NOT NULL,
  'meta.dex.tokenOut' INTEGER NOT NULL,

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
    ('meta.dex.tokenIn')
  REFERENCES
    'dex.tokens'('id'),

  FOREIGN KEY
    ('meta.dex.tokenOut')
  REFERENCES
    'dex.tokens'('id')
);

/* add unique index constraint */
CREATE UNIQUE INDEX
  'event.Swap--block.header.height,tx.index,tx_result.events.index'
ON
  'event.Swap' (
    'block.header.height',
    'tx.index',
    'tx_result.events.index'
  );
