
import db from '../../db.mjs';

function translateEvents({ type, attributes }, index) {
  return {
    index,
    type,
    attributes: attributes.reduce((acc, { key, value }) => {
      if (key) {
        const decodedKey = Buffer.from(key, 'base64').toString('utf8');
        const decodedValue = value ? Buffer.from(value, 'base64').toString('utf8') : null;
        acc[decodedKey] = decodedValue;  
      }
      return acc;
    }, {}),
  }
}

let getBlockTimeFromBlockHeight;
async function getBlockHeightFromTx(tx) {
  // activate at run time (after db has been initialized)
  getBlockTimeFromBlockHeight = getBlockTimeFromBlockHeight || db.prepare(`
    SELECT 'block'.'header.time_unix' FROM 'block'
      WHERE ('block'.'header.height' = ?)
  `);

  // if event has tokens, ensure these tokens are present in the DB
  if (tx.height) {
    return new Promise((resolve, reject) => {
      getBlockTimeFromBlockHeight.get([
        // 'block.header.time_unix' INTEGER NOT NULL,
        Number(tx.height),
      ], (err, result) => err ? reject(err) : resolve(result));
    })
    // pick the desired column value out
    .then(result => result['header.time_unix']);
  }
}


let getDexPairs;
let insertDexPairs;
async function insertDexPairsRows(txEvent) {
  // activate at run time (after db has been initialized)
  getDexPairs = getDexPairs || db.prepare(`
    SELECT 'dex.pairs'.'id' FROM 'dex.pairs' WHERE (
      'dex.pairs'.'token0' = ? AND
      'dex.pairs'.'token1' = ?
    )
  `);
  insertDexPairs = insertDexPairs || db.prepare(`
    INSERT OR IGNORE INTO 'dex.pairs' (
      'token0',
      'token1'
    ) values (?, ?)
  `);

  // if event has tokens, ensure these tokens are present in the DB
  if (txEvent.attributes.Token0 && txEvent.attributes.Token1) {
    return new Promise((resolve, reject) => {
      getDexPairs.get([
        // 'token0' TEXT NOT NULL,
        txEvent.attributes.Token0,
        // 'token1' TEXT NOT NULL,
        txEvent.attributes.Token1,
      ], (err, result) => {
        if (err) {
          return reject(err);
        }
        // return found id
        const id = result?.['id'];
        if (id) {
          return resolve(id);
        }
        // or insert new pair
        insertDexPairs.run([
          // 'token0' TEXT NOT NULL,
          txEvent.attributes.Token0,
          // 'token1' TEXT NOT NULL,
          txEvent.attributes.Token1,
        ], function(err) {
          err ? reject(err) : resolve(this.lastID)
        });
      })
    });
  }
}


let insertTx;
async function insertTxRows(tx) {
  // activate at run time (after db has been initialized)
  insertTx = insertTx || db.prepare(`
    INSERT INTO 'tx' (
      'block.header.height',
      'block.header.time_unix',
      'hash',
      'index',
      'tx_result.code',
      'tx_result.data',
      'tx_result.log',
      'tx_result.info',
      'tx_result.gas_wanted',
      'tx_result.gas_used',
      'tx_result.codespace',
      'tx'
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return new Promise(async (resolve, reject) => {
    insertTx.run([
      // 'block.header.height' INTEGER NOT NULL,
      tx.height,
      // 'block.header.time_unix' INTEGER NOT NULL,
      await getBlockHeightFromTx(tx),
      // 'hash' TEXT NOT NULL,
      tx.hash,
      // 'index' INTEGER NOT NULL,
      tx.index,
      // 'tx_result.code' INTEGER NOT NULL,
      tx.tx_result.code,
      // 'tx_result.data' TEXT,
      tx.tx_result.data,
      // 'tx_result.log' TEXT NOT NULL,
      tx.tx_result.log,
      // 'tx_result.info' TEXT,
      tx.tx_result.info,
      // 'tx_result.gas_wanted' TEXT NOT NULL,
      tx.tx_result.gas_wanted,
      // 'tx_result.gas_used' TEXT NOT NULL,
      tx.tx_result.gas_used,
      // 'tx_result.codespace' TEXT NOT NULL,
      tx.index,
      // 'tx' TEXT NOT NULL,
      tx.tx,
    ], err => err ? reject(err) : resolve());
  });
}


let insertTxEvent;
async function insertTxEventRows(tx, txEvent) {
  // activate at run time (after db has been initialized)
  insertTxEvent = insertTxEvent || db.prepare(`
    INSERT INTO 'tx_result.events' (
      'block.header.height',
      'block.header.time_unix',
      'tx.index',
      'tx.tx_result.code',
      'index',
      'type',
      'attributes',
      'meta.dex.pair_swap',
      'meta.dex.pair_deposit',
      'meta.dex.pair_withdraw'
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const isDexMessage = txEvent.type === 'message' && txEvent.attributes.module === 'dex';
  const getPairId = async () => {
    return new Promise((resolve, reject) => {
      getDexPairs.get([
        // 'token0' TEXT NOT NULL,
        txEvent.attributes.Token0,
        // 'token1' TEXT NOT NULL,
        txEvent.attributes.Token1,
      ], (err, result) => err ? reject(err) : resolve(result['id']));
    });
  };

  return new Promise(async (resolve, reject) => {
    insertTxEvent.run([
      // 'block.header.height' INTEGER NOT NULL,
      tx.height,
      // 'block.header.time_unix' INTEGER NOT NULL,
      await getBlockHeightFromTx(tx),
      // 'tx.index' INTEGER NOT NULL,
      tx.index,
      // 'tx.tx_result.code' INTEGER NOT NULL,
      tx.tx_result.code,

      // 'index' INTEGER NOT NULL,
      txEvent.index,
      // 'type' TEXT NOT NULL,
      txEvent.type,
      // 'attributes' TEXT NOT NULL,
      JSON.stringify(txEvent.attributes),

      // 'meta.dex.pair_swap' INTEGER NOT NULL,
      isDexMessage && txEvent.attributes.action === 'NewSwap' && await getPairId(),
      // 'meta.dex.pair_deposit' INTEGER NOT NULL,
      isDexMessage && txEvent.attributes.action === 'NewDeposit' && await getPairId(),
      // 'meta.dex.pair_withdraw' INTEGER NOT NULL,
      isDexMessage && txEvent.attributes.action === 'NewWithdraw' && await getPairId(),
    ], err => err ? reject(err) : resolve());
  });
}



export default async function ingestTxs (txPage) {
  return await Promise.all(txPage.map(async tx => {
    const txEvents = (tx.tx_result.events || []).map(translateEvents);
    // first add token foreign keys
    await Promise.all(txEvents.map(insertDexPairsRows));
    // then add transaction rows
    await insertTxRows(tx);
    // then add transaction event rows
    await Promise.all(txEvents.map(txEvent => insertTxEventRows(tx, txEvent)));
  }));
};
