
/*
  * setup events table with many foreign keys and derived metadata flags
  * attributes are JSON blobs (it's ok,
  *   they need to be extracted out into BigNumbers to be useful anyway)
  */
CREATE TABLE 'tx_result.events' (
  'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,

  'index' INTEGER NOT NULL,
  'type' TEXT NOT NULL,
  'attributes' TEXT NOT NULL,

  'related.block' INTEGER NOT NULL,
  'related.tx' INTEGER NOT NULL,
  'related.dex.pair_swap' INTEGER NOT NULL,
  'related.dex.pair_deposit' INTEGER NOT NULL,
  'related.dex.pair_withdraw' INTEGER NOT NULL,

  FOREIGN KEY ('related.block')
    REFERENCES 'block'('id'),

  FOREIGN KEY ('related.tx')
    REFERENCES 'tx'('id'),

  FOREIGN KEY ('related.dex.pair_swap')
    REFERENCES 'dex.pairs'('id'),

  FOREIGN KEY ('related.dex.pair_deposit')
    REFERENCES 'dex.pairs'('id'),

  FOREIGN KEY ('related.dex.pair_withdraw')
    REFERENCES 'dex.pairs'('id')
);

/* ensure block + tx + event combination is unique */
CREATE UNIQUE INDEX
  'tx_result.events--related.block,related.tx,index'
ON
  'tx_result.events' (
    'related.block',
    'related.tx',
    'index'
  );
