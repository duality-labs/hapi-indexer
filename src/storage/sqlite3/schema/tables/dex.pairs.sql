
/* setup module foreign key indexes to be used first */
CREATE TABLE 'dex.pairs' (
  'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  'token0' INTEGER NOT NULL,
  'token1' INTEGER NOT NULL,

  FOREIGN KEY ('token0')
    REFERENCES 'dex.tokens'('id')
  FOREIGN KEY ('token1')
    REFERENCES 'dex.tokens'('id')

);

/* ensure token combination is unique */
CREATE UNIQUE INDEX
  'dex.pairs--token0,token1'
ON
  'dex.pairs' (
    'token0',
    'token1'
  );
