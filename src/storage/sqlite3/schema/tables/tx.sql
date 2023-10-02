
/* setup transactions table with block height foreign key */
CREATE TABLE 'tx' (
  'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,

  'hash' TEXT NOT NULL,
  'index' INTEGER NOT NULL,
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

/* ensure block + tx combination is unique */
CREATE UNIQUE INDEX
  'tx--related.block,index'
ON
  'tx' (
    'related.block',
    'index'
  );

CREATE INDEX
  'tx--index'
ON
  'tx' (
    'index'
  );

CREATE INDEX
  'tx--tx_result.code'
ON
  'tx' (
    'tx_result.code'
  );
