
/* setup blocks table with indexed columns to be used as foreign keys */
CREATE TABLE 'block' (
  'header.height' INTEGER PRIMARY KEY NOT NULL,
  'header.time' TEXT NOT NULL,

  'header.time_unix' INTEGER UNIQUE NOT NULL
);
