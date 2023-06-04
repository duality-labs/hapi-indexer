
/* setup transactions table with block height foreign key */
CREATE TABLE 'tx' (
  'block.header.height' INTEGER NOT NULL,
  'block.header.time_unix' INTEGER NOT NULL,
  'hash' TEXT NOT NULL,
  'index' INTEGER NOT NULL,
  'tx_result.code' INTEGER NOT NULL,
  'tx_result.data' TEXT,
  'tx_result.log' TEXT NOT NULL,
  'tx_result.info' TEXT,
  'tx_result.gas_wanted' TEXT NOT NULL,
  'tx_result.gas_used' TEXT NOT NULL,
  'tx_result.codespace' TEXT,

  FOREIGN KEY ('block.header.height')
    REFERENCES 'block'('header.height'),

  FOREIGN KEY ('block.header.time_unix')
    REFERENCES 'block'('header.time_unix')
);

/* ensure block.height + tx.index combination is unique */
CREATE INDEX
  'tx--block.header.height,index'
ON
  'tx' (
    'block.header.height',
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
