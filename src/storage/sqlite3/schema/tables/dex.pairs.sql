
/* setup module foreign key indexes to be used first */
CREATE TABLE 'dex.pairs' (
  'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  'token0' TEXT NOT NULL,
  'token1' TEXT NOT NULL
);

/* ensure token combination is unique */
CREATE UNIQUE INDEX
  'dex.pairs--token0,token1'
ON
  'dex.pairs' (
    'token0',
    'token1'
  );
