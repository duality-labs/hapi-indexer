
/*
 * add derived data from tick update data to know the state of
 * all ticks throughout time
 */
CREATE TABLE 'derived.tick_state' (
  'meta.dex.pair' INTEGER NOT NULL,
  'meta.dex.token' INTEGER NOT NULL,

  'TickIndex' INTEGER NOT NULL,
  'Reserves' TEXT NOT NULL,

  FOREIGN KEY
    ('meta.dex.pair')
  REFERENCES
    'dex.pairs'('id'),

  FOREIGN KEY
    ('meta.dex.token')
  REFERENCES
    'dex.tokens'('id')
);

/* add unique index for tick state to ensure no duplicate tick state */
CREATE UNIQUE INDEX
  'derived.tick_state--meta.dex.pair,meta.dex.token,TickIndex'
ON
  'derived.tick_state' (
    'meta.dex.pair',
    'meta.dex.token',
    'TickIndex'
  );
