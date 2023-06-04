
/*
 * add derived data from tick update data to know the state of
 * all ticks throughout time
 */
CREATE TABLE 'derived.tick_state' (
  'related.dex.pair' INTEGER NOT NULL,
  'related.dex.token' INTEGER NOT NULL,

  'TickIndex' INTEGER NOT NULL,
  'Reserves' TEXT NOT NULL,

  FOREIGN KEY
    ('related.dex.pair')
  REFERENCES
    'dex.pairs'('id'),

  FOREIGN KEY
    ('related.dex.token')
  REFERENCES
    'dex.tokens'('id')
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
