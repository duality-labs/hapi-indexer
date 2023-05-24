
/*
  * setup events table with many foreign keys and derived metadata flags
  * attributes are JSON blobs (it's ok,
  *   they need to be extracted out into BigNumbers to be useful anyway)
  */
CREATE TABLE 'tx_result.events' (
  'block.header.height' INTEGER NOT NULL,
  'block.header.time_unix' INTEGER NOT NULL,
  'tx.index' INTEGER NOT NULL,
  'tx.tx_result.code' INTEGER NOT NULL,

  'index' INTEGER NOT NULL,
  'type' TEXT NOT NULL,
  'attributes' TEXT NOT NULL,

  'meta.dex.pair_swap' INTEGER NOT NULL,
  'meta.dex.pair_deposit' INTEGER NOT NULL,
  'meta.dex.pair_withdraw' INTEGER NOT NULL,

  FOREIGN KEY
    ('block.header.height')
  REFERENCES
    'block'('header.height'),

  FOREIGN KEY
    ('block.header.time_unix')
  REFERENCES
    'block'('header.time_unix'),

  FOREIGN KEY
    ('tx.index')
  REFERENCES
    'tx'('index'),

  FOREIGN KEY
    ('tx.tx_result.code')
  REFERENCES
    'tx'('tx_result.code'),


  FOREIGN KEY
    ('meta.dex.pair_swap')
  REFERENCES
    'dex.pairs'('id'),

  FOREIGN KEY
    ('meta.dex.pair_deposit')
  REFERENCES
    'dex.pairs'('id'),

  FOREIGN KEY
    ('meta.dex.pair_withdraw')
  REFERENCES
    'dex.pairs'('id')
);

/* ensure block.height + tx.index combination is unique */
CREATE UNIQUE INDEX
  'tx_result.events--block.header.height,tx.index,index'
ON
  'tx_result.events' (
    'block.header.height',
    'tx.index',
    'index'
  );
