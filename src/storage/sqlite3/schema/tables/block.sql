
/* setup blocks table with indexed columns to be used as foreign keys */
CREATE TABLE 'block' (
  'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  'header.height' INTEGER NOT NULL UNIQUE,
  'header.time' TEXT NOT NULL,

  'header.time_unix' INTEGER UNIQUE NOT NULL
);

CREATE INDEX
  'block--header.time_unix'
ON
  'block' (
    'header.time_unix'
  );

CREATE INDEX
  'block--header.height'
ON
  'block' (
    'header.height'
  );
