
/*
 * add tx_msg_type table to act like an enum type, define our Msg types
 */

CREATE TABLE 'tx_msg_type' (
  'id' INTEGER PRIMARY KEY,
  'action' TEXT NOT NULL
);

/* add lookup index */
CREATE UNIQUE INDEX
  'tx_msg_type--action'
ON
  'tx_msg_type' (
    'action'
  );

/* add values */
INSERT INTO 'tx_msg_type' ('id', 'action')
  VALUES (1,'neutron.dex.MsgDeposit');
INSERT INTO 'tx_msg_type' ('id', 'action')
  VALUES (2,'neutron.dex.MsgWithdrawal');
INSERT INTO 'tx_msg_type' ('id', 'action')
  VALUES (3,'neutron.dex.MsgPlaceLimitOrder');


/*
 * add derived msg state for tx_result.events
 * create reference for each Tx Msg, using specific events as flag posts
 * to denote which Msg each Tx event belongs to
 */
CREATE TABLE 'tx_msg' (
  'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,

  'related.tx_msg_type' INTEGER,

  FOREIGN KEY ('related.tx_msg_type')
    REFERENCES 'tx_msg_type'('id')
);

/* add lookup index */
CREATE INDEX
  'tx_msg--related.tx_msg_type'
ON
  'tx_msg' (
    'related.tx_msg_type'
  );
