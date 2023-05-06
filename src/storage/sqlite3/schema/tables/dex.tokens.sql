
/* setup module foreign key indexes to be used first */
CREATE TABLE 'dex.tokens' (
  'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  'token' TEXT NOT NULL
);

/* ensure token combination is unique */
CREATE UNIQUE INDEX
  'dex.tokens--token'
ON
  'dex.tokens' (
    'token'
  );
