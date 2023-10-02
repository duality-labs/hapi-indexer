
/* setup transactions table with block height foreign key */
CREATE TABLE 'tx' (
  'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,

  'hash' TEXT NOT NULL,
  'tx_result.code' INTEGER NOT NULL,
  'tx_result.data' TEXT,
  'tx_result.info' TEXT,
  'tx_result.gas_wanted' TEXT NOT NULL,
  'tx_result.gas_used' TEXT NOT NULL,
  'tx_result.codespace' TEXT,

  'related.block' INTEGER NOT NULL,

  FOREIGN KEY ('related.block')
    REFERENCES 'block'('id')

);

/* create unique lookup entrypoint */
CREATE UNIQUE INDEX
  'tx--hash'
ON
  'tx' (
    'hash'
  );

/* allow faster lookups if a height is known */
/* the height+index combination looks unique but is not */
CREATE INDEX
  'tx--related.block'
ON
  'tx' (
    'related.block'
  );

/* allow faster lookups of successfuly transactions */
CREATE INDEX
  'tx--tx_result.code'
ON
  'tx' (
    'tx_result.code'
  );
