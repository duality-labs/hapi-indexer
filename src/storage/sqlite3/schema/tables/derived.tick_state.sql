
/*
 * add derived data from tick update data to know the state of
 * all ticks throughout time
 */
CREATE TABLE 'derived.tick_state' (

  'TickIndex' INTEGER NOT NULL,
  'Reserves' TEXT NOT NULL,

  'related.dex.pair' INTEGER NOT NULL,
  'related.dex.token' INTEGER NOT NULL,
  'related.block.header.height' INTEGER NOT NULL,

  FOREIGN KEY ('related.dex.pair')
    REFERENCES 'dex.pairs'('id'),

  FOREIGN KEY ('related.dex.token')
    REFERENCES 'dex.tokens'('id'),

  FOREIGN KEY ('related.block.header.height')
    REFERENCES 'block'('header.height')
);

/* add unique index for tick state to ensure no duplicate tick state */
CREATE UNIQUE INDEX
  'derived.tick_state--related.dex.pair,related.dex.token,TickIndex'
ON
  'derived.tick_state' (
    'related.dex.pair',
    'related.dex.token',
    'TickIndex'
  );

/* add index for quicker lookups filtering to block height */
CREATE INDEX
  'derived.tick_state--related.block.header.height'
ON
  'derived.tick_state' (
    'related.block.header.height'
  );
