import db from './db.mjs'

function promisify(unpromisifiedCallback) {
  return new Promise((resolve, reject) => {
    unpromisifiedCallback(err => err ? reject(err) : resolve());
  })
}

export default async function init() {

  const promises = [];
  db.serialize(() => {

    // setup module foreign key indexes to be used first
    promises.push(promisify(cb => {
      db.run(`
        CREATE TABLE 'dex.pairs' (
          'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          'token0' TEXT NOT NULL,
          'token1' TEXT NOT NULL
        );
      `, cb);
    }));
    // ensure token combination is unique
    promises.push(promisify(cb => {
      db.run(`
        CREATE UNIQUE INDEX 'dex.pairs.token0--token1' ON 'dex.pairs' (
          'token0',
          'token1'
        );
      `, cb);
    }));

    // setup blocks table with indexed columns to be used as foreign keys
    promises.push(promisify(cb => {
      db.run(`
        CREATE TABLE 'block' (
          'header.height' INTEGER PRIMARY KEY NOT NULL,
          'header.time' TEXT NOT NULL,

          'header.time_unix' INTEGER UNIQUE NOT NULL
        );
      `, cb);
    }));

    // setup transactions table with block height foreign key
    promises.push(promisify(cb => {
      db.run(`
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

          FOREIGN KEY('block.header.height') REFERENCES 'block'('header.height'),
          FOREIGN KEY('block.header.time_unix') REFERENCES 'block'('header.time_unix')
        );
      `, cb);
    }));
    // ensure block.height + tx.index combination is unique
    promises.push(promisify(cb => {
      db.run(`
        CREATE INDEX 'block.header.height--index' ON 'tx' (
          'block.header.height',
          'index'
        );
        CREATE INDEX 'tx.index' ON 'tx' (
          'index'
        );
        CREATE INDEX 'tx.tx_result.code' ON 'tx' (
          'tx_result.code'
        );
      `, cb);
    }));

    // setup events table with many foreign keys and derived metadata flags
    // attributes are JSON blobs (it's ok, they need to be extracted out into BigNumbers to be useful anyway)
    promises.push(promisify(cb => {
      db.run(`
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

          FOREIGN KEY('block.header.height') REFERENCES 'block'('header.height'),
          FOREIGN KEY('block.header.time_unix') REFERENCES 'block'('header.time_unix'),
          FOREIGN KEY('tx.index') REFERENCES 'tx'('index'),
          FOREIGN KEY('tx.tx_result.code') REFERENCES 'tx'('tx_result.code'),

          FOREIGN KEY('meta.dex.pair_swap') REFERENCES 'dex.pairs'('id'),
          FOREIGN KEY('meta.dex.pair_deposit') REFERENCES 'dex.pairs'('id'),
          FOREIGN KEY('meta.dex.pair_withdraw') REFERENCES 'dex.pairs'('id')
        );
      `, cb);
    }));
    // ensure block.height + tx.index + event.index combination is unique
    promises.push(promisify(cb => {
      db.run(`
        CREATE UNIQUE INDEX 'block.header.height--tx.index,index' ON 'tx_result.events' (
          'block.header.height',
          'tx.index',
          'index'
        );
      `, cb);
    }));

  });

  return await Promise.all(promises);
}
