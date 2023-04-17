
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


let insertBlock;
async function insertBlockRows(tx_result) {
  // activate at run time (after db has been initialized)
  insertBlock = insertBlock || db.prepare(`
    INSERT OR IGNORE INTO 'block' (
      'header.height',
      'header.time',
      'header.time_unix'
    ) values (?, ?, ?)
  `);

  return new Promise((resolve, reject) => {
    insertBlock.run([
      // 'header.height' INTEGER PRIMARY KEY NOT NULL,
      tx_result.height,
      // 'header.time' TEXT NOT NULL,
      tx_result.timestamp,
      // 'header.time_unix' INTEGER UNIQUE NOT NULL
      getBlockTimeFromTxResult(tx_result),
    ], err => err ? reject(err) : resolve());
  });
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


function getBlockTimeFromTxResult(tx_result) {
  // activate at run time (after db has been initialized)
  return Math.round(new Date(tx_result.timestamp).valueOf() / 1000);
}

let insertTx;
async function insertTxRows(tx_result, index) {
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
      'tx_result.codespace'
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return new Promise(async (resolve, reject) => {
    insertTx.run([
      // 'block.header.height' INTEGER NOT NULL,
      tx_result.height,
      // 'block.header.time_unix' INTEGER NOT NULL,
      getBlockTimeFromTxResult(tx_result),
      // 'hash' TEXT NOT NULL,
      tx_result.txhash,
      // 'index' INTEGER NOT NULL,
      index,
      // 'tx_result.code' INTEGER NOT NULL,
      tx_result.code,
      // 'tx_result.data' TEXT,
      tx_result.data,
      // 'tx_result.log' TEXT NOT NULL,
      tx_result.raw_log,
      // 'tx_result.info' TEXT,
      tx_result.info,
      // 'tx_result.gas_wanted' TEXT NOT NULL,
      tx_result.gas_wanted,
      // 'tx_result.gas_used' TEXT NOT NULL,
      tx_result.gas_used,
      // 'tx_result.codespace' TEXT NOT NULL,
      tx_result.codespace,
    ], err => err ? reject(err) : resolve());
  });
}


let insertTxEvent;
async function insertTxEventRows(tx_result, txEvent, index) {
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
  const dexPairId = isDexMessage && txEvent.attributes.Token0 && txEvent.attributes.Token1 && (
    new Promise((resolve, reject) => {
      getDexPairs.get([
        // 'token0' TEXT NOT NULL,
        txEvent.attributes.Token0,
        // 'token1' TEXT NOT NULL,
        txEvent.attributes.Token1,
      ], (err, result) => err ? reject(err) : resolve(result['id']));
    })
  );

  const blockTime = getBlockTimeFromTxResult(tx_result);
  return new Promise(async (resolve, reject) => {
    insertTxEvent.run([
      // 'block.header.height' INTEGER NOT NULL,
      tx_result.height,
      // 'block.header.time_unix' INTEGER NOT NULL,
      blockTime,
      // 'tx.index' INTEGER NOT NULL,
      index,
      // 'tx.tx_result.code' INTEGER NOT NULL,
      tx_result.code,

      // 'index' INTEGER NOT NULL,
      txEvent.index,
      // 'type' TEXT NOT NULL,
      txEvent.type,
      // 'attributes' TEXT NOT NULL,
      JSON.stringify(txEvent.attributes),

      // 'meta.dex.pair_swap' INTEGER NOT NULL,
      isDexMessage && txEvent.attributes.action === 'NewSwap' && await dexPairId,
      // 'meta.dex.pair_deposit' INTEGER NOT NULL,
      isDexMessage && txEvent.attributes.action === 'NewDeposit' && await dexPairId,
      // 'meta.dex.pair_withdraw' INTEGER NOT NULL,
      isDexMessage && txEvent.attributes.action === 'NewWithdraw' && await dexPairId,
    ], async function(err) {
      if (err) {
        return reject(err)
      }
      // add event row to specific event table:
      if (txEvent.attributes.action === 'NewSwap') {
        return db.run(`
          INSERT INTO 'event.NewSwap' (
            'block.header.height',
            'block.header.time_unix',

            'Creator',
            'Receiver',
            'Token0',
            'Token1',
            'TokenIn',
            'AmountIn',
            'AmountOut',
            'MinOut',

            'meta.dex.pair'
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          // 'block.header.height' INTEGER NOT NULL,
          tx_result.height,
          // 'block.header.time_unix' INTEGER NOT NULL,
          blockTime,
          // attributes
          txEvent.attributes['Creator'],
          txEvent.attributes['Receiver'],
          txEvent.attributes['Token0'],
          txEvent.attributes['Token1'],
          txEvent.attributes['TokenIn'],
          txEvent.attributes['AmountIn'],
          txEvent.attributes['AmountOut'],
          txEvent.attributes['MinOut'],
          await dexPairId,
        ], err => err ? reject(err) : resolve())
      }
      else if (txEvent.attributes.action === 'NewDeposit') {
        return db.run(`
          INSERT INTO 'event.NewDeposit' (
            'block.header.height',
            'block.header.time_unix',

            'Creator',
            'Receiver',
            'Token0',
            'Token1',
            'TickIndex',
            'FeeIndex',
            'OldReserves0',
            'NewReserves0',
            'OldReserves1',
            'NewReserves1',
            'SharesMinted',

            'meta.dex.pair'
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          // 'block.header.height' INTEGER NOT NULL,
          tx_result.height,
          // 'block.header.time_unix' INTEGER NOT NULL,
          blockTime,
          // attributes
          txEvent.attributes['Creator'],
          txEvent.attributes['Receiver'],
          txEvent.attributes['Token0'],
          txEvent.attributes['Token1'],
          txEvent.attributes['TickIndex'],
          txEvent.attributes['FeeIndex'],
          txEvent.attributes['OldReserves0'],
          txEvent.attributes['NewReserves0'],
          txEvent.attributes['OldReserves1'],
          txEvent.attributes['NewReserves1'],
          txEvent.attributes['SharesMinted'],
          await dexPairId,
        ], err => err ? reject(err) : resolve())
      }
      else if (txEvent.attributes.action === 'NewWithdraw') {
        return db.run(`
          INSERT INTO 'event.NewWithdraw' (
            'block.header.height',
            'block.header.time_unix',

            'Creator',
            'Receiver',
            'Token0',
            'Token1',
            'TickIndex',
            'FeeIndex',
            'OldReserves0',
            'NewReserves0',
            'OldReserves1',
            'NewReserves1',
            'SharesRemoved',

            'meta.dex.pair'
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          // 'block.header.height' INTEGER NOT NULL,
          tx_result.height,
          // 'block.header.time_unix' INTEGER NOT NULL,
          blockTime,
          // attributes
          txEvent.attributes['Creator'],
          txEvent.attributes['Receiver'],
          txEvent.attributes['Token0'],
          txEvent.attributes['Token1'],
          txEvent.attributes['TickIndex'],
          txEvent.attributes['FeeIndex'],
          txEvent.attributes['OldReserves0'],
          txEvent.attributes['NewReserves0'],
          txEvent.attributes['OldReserves1'],
          txEvent.attributes['NewReserves1'],
          txEvent.attributes['SharesRemoved'],
          await dexPairId,
        ], err => err ? reject(err) : resolve())
      }
      resolve(this.lastID)
    });
  });
}


export default async function ingestTxs (txPage) {
  return await Promise.all(txPage.map(async (tx_result, index) => {
    const txEvents = (tx_result.events || []).map(translateEvents);
    // first add block rows
    await insertBlockRows(tx_result);
    // then add token foreign keys
    await Promise.all(txEvents.map(insertDexPairsRows));
    // then add transaction rows
    await insertTxRows(tx_result, index);
    // then add transaction event rows
    await Promise.all(txEvents.map(txEvent => insertTxEventRows(tx_result, txEvent, index)));
  }));
};
