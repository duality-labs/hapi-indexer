import sql from 'sql-template-strings';
import db from './db/db.js';

export default async function init() {
  const promises: Array<Promise<unknown>> = [];
  db.getDatabaseInstance().serialize(() => {
    // setup module foreign key indexes to be used first
    promises.push(
      db.run(sql`
        CREATE TABLE 'dex.tokens' (
          'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          'token' TEXT NOT NULL
        );
      `)
    );
    // ensure token combination is unique
    promises.push(
      db.run(sql`
        CREATE UNIQUE INDEX
          'dex.tokens--token'
        ON
          'dex.tokens' (
            'token'
          );
      `)
    );

    // setup module foreign key indexes to be used first
    promises.push(
      db.run(sql`
        CREATE TABLE 'dex.pairs' (
          'id' INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          'token0' TEXT NOT NULL,
          'token1' TEXT NOT NULL
        );
      `)
    );
    // ensure token combination is unique
    promises.push(
      db.run(sql`
        CREATE UNIQUE INDEX
          'dex.pairs--token0,token1'
        ON
          'dex.pairs' (
            'token0',
            'token1'
          );
      `)
    );

    // setup blocks table with indexed columns to be used as foreign keys
    promises.push(
      db.run(sql`
        CREATE TABLE 'block' (
          'header.height' INTEGER PRIMARY KEY NOT NULL,
          'header.time' TEXT NOT NULL,

          'header.time_unix' INTEGER UNIQUE NOT NULL
        );
      `)
    );

    // setup transactions table with block height foreign key
    promises.push(
      db.run(sql`
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

          FOREIGN KEY
            ('block.header.height')
          REFERENCES
            'block'('header.height'),

          FOREIGN KEY
            ('block.header.time_unix')
          REFERENCES
            'block'('header.time_unix')
        );
      `)
    );
    // ensure block.height + tx.index combination is unique
    promises.push(
      db.run(sql`
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
      `)
    );

    // setup events table with many foreign keys and derived metadata flags
    // attributes are JSON blobs (it's ok,
    //   they need to be extracted out into BigNumbers to be useful anyway)
    promises.push(
      db.run(sql`
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
      `)
    );
    // ensure block.height + tx.index + event.index combination is unique
    promises.push(
      db.run(sql`
        CREATE UNIQUE INDEX
          'tx_result.events--block.header.height,tx.index,index'
        ON
          'tx_result.events' (
            'block.header.height',
            'tx.index',
            'index'
          );
      `)
    );

    // setup events tables for specific events
    // these are key values form the event attributes (in 'tx_result.events'.'attributes' as JSON blobs
    promises.push(
      db.run(sql`
        CREATE TABLE 'event.Deposit' (
          'block.header.height' INTEGER NOT NULL,
          'block.header.time_unix' INTEGER NOT NULL,
          'tx.index' INTEGER NOT NULL,
          'tx_result.events.index' INTEGER NOT NULL,

          'Creator' TEXT NOT NULL,
          'Receiver' TEXT NOT NULL,
          'Token0' TEXT NOT NULL,
          'Token1' TEXT NOT NULL,
          'TickIndex' INTEGER NOT NULL,
          'Fee' INTEGER NOT NULL,
          'Reserves0Deposited' TEXT NOT NULL,
          'Reserves1Deposited' TEXT NOT NULL,
          'SharesMinted' TEXT NOT NULL,

          'meta.dex.pair' INTEGER NOT NULL,

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
            ('tx_result.events.index')
          REFERENCES
            'tx_result.events'('index'),

          FOREIGN KEY
            ('meta.dex.pair')
          REFERENCES
            'dex.pairs'('id')
        );
      `)
    );
    // add unique index constraint
    promises.push(
      db.run(sql`
        CREATE UNIQUE INDEX
          'event.Deposit--block.header.height,tx.index,tx_result.events.index'
        ON
          'event.Deposit' (
            'block.header.height',
            'tx.index',
            'tx_result.events.index'
          );
      `)
    );
    promises.push(
      db.run(sql`
        CREATE TABLE 'event.Withdraw' (
          'block.header.height' INTEGER NOT NULL,
          'block.header.time_unix' INTEGER NOT NULL,
          'tx.index' INTEGER NOT NULL,
          'tx_result.events.index' INTEGER NOT NULL,

          'Creator' TEXT NOT NULL,
          'Receiver' TEXT NOT NULL,
          'Token0' TEXT NOT NULL,
          'Token1' TEXT NOT NULL,
          'TickIndex' INTEGER NOT NULL,
          'Fee' INTEGER NOT NULL,
          'Reserves0Withdrawn' TEXT NOT NULL,
          'Reserves1Withdrawn' TEXT NOT NULL,
          'SharesRemoved' TEXT NOT NULL,

          'meta.dex.pair' INTEGER NOT NULL,

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
            ('tx_result.events.index')
          REFERENCES
            'tx_result.events'('index'),

          FOREIGN KEY
            ('meta.dex.pair')
          REFERENCES
            'dex.pairs'('id')
        );
      `)
    );
    // add unique index constraint
    promises.push(
      db.run(sql`
        CREATE UNIQUE INDEX
          'event.Withdraw--block.header.height,tx.index,tx_result.events.index'
        ON
          'event.Withdraw' (
            'block.header.height',
            'tx.index',
            'tx_result.events.index'
          );
      `)
    );
    promises.push(
      db.run(sql`
        CREATE TABLE 'event.Swap' (
          'block.header.height' INTEGER NOT NULL,
          'block.header.time_unix' INTEGER NOT NULL,
          'tx.index' INTEGER NOT NULL,
          'tx_result.events.index' INTEGER NOT NULL,

          'Creator' TEXT NOT NULL,
          'Receiver' TEXT NOT NULL,
          'Token0' TEXT NOT NULL,
          'Token1' TEXT NOT NULL,
          'TokenIn' TEXT NOT NULL,
          'TokenOut' TEXT NOT NULL,
          'AmountIn' TEXT NOT NULL,
          'AmountOut' TEXT NOT NULL,

          'meta.dex.pair' INTEGER NOT NULL,
          'meta.dex.tokenIn' INTEGER NOT NULL,
          'meta.dex.tokenOut' INTEGER NOT NULL,

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
            ('tx_result.events.index')
          REFERENCES
            'tx_result.events'('index'),

          FOREIGN KEY
            ('meta.dex.pair')
          REFERENCES
            'dex.pairs'('id'),

          FOREIGN KEY
            ('meta.dex.tokenIn')
          REFERENCES
            'dex.tokens'('id'),

          FOREIGN KEY
            ('meta.dex.tokenOut')
          REFERENCES
            'dex.tokens'('id')
        );
      `)
    );
    // add unique index constraint
    promises.push(
      db.run(sql`
        CREATE UNIQUE INDEX
          'event.Swap--block.header.height,tx.index,tx_result.events.index'
        ON
          'event.Swap' (
            'block.header.height',
            'tx.index',
            'tx_result.events.index'
          );
      `)
    );

    // add ticks table to hold all ticks data
    // (larger and more frequently changing than other tables)
    promises.push(
      db.run(sql`
        CREATE TABLE 'event.TickUpdate' (
          'block.header.height' INTEGER NOT NULL,
          'block.header.time_unix' INTEGER NOT NULL,
          'tx.index' INTEGER NOT NULL,
          'tx_result.events.index' INTEGER NOT NULL,

          'Token0' TEXT NOT NULL,
          'Token1' TEXT NOT NULL,
          'Token' TEXT NOT NULL,
          'TickIndex' INTEGER NOT NULL,
          'Reserves' TEXT NOT NULL,

          'meta.dex.pair' INTEGER NOT NULL,
          'meta.dex.token' INTEGER NOT NULL,

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
            ('tx_result.events.index')
          REFERENCES
            'tx_result.events'('index'),

          FOREIGN KEY
            ('meta.dex.pair')
          REFERENCES
            'dex.pairs'('id'),

          FOREIGN KEY
            ('meta.dex.token')
          REFERENCES
            'dex.tokens'('id')
        );
      `)
    );
    // add unique index constraint
    promises.push(
      db.run(sql`
        CREATE UNIQUE INDEX
          'event.TickUpdate--block.header.height,tx.index,tx_result.events.index'
        ON
          'event.TickUpdate' (
            'block.header.height',
            'tx.index',
            'tx_result.events.index'
          );
      `)
    );
    // add index for quick timeseries lookups, ie. lookup by pair id and then time
    promises.push(
      db.run(sql`
        CREATE INDEX
          'event.TickUpdate--meta.dex.pair,block.header.time_unix'
        ON
          'event.TickUpdate' (
            'meta.dex.pair',
            'block.header.time_unix'
          );
      `)
    );

    // add derived data from tick update data to know the state of all ticks throughout time
    promises.push(
      db.run(sql`
        CREATE TABLE 'derived.tick_state' (
          'meta.dex.pair' INTEGER NOT NULL,
          'meta.dex.token' INTEGER NOT NULL,

          'TickIndex' INTEGER NOT NULL,
          'Reserves' TEXT NOT NULL,

          FOREIGN KEY
            ('meta.dex.pair')
          REFERENCES
            'dex.pairs'('id'),

          FOREIGN KEY
            ('meta.dex.token')
          REFERENCES
            'dex.tokens'('id')
        );
      `)
    );
    // add unique index for tick state to ensure no duplicate tick state
    promises.push(
      db.run(sql`
        CREATE UNIQUE INDEX
          'derived.tick_state--meta.dex.pair,meta.dex.token,TickIndex'
        ON
          'derived.tick_state' (
            'meta.dex.pair',
            'meta.dex.token',
            'TickIndex'
          );
      `)
    );

    // add derived data from tick update data to know the state of all ticks throughout time
    promises.push(
      db.run(sql`
        CREATE TABLE 'derived.tx_price_data' (
          'block.header.height' INTEGER NOT NULL,
          'block.header.time_unix' INTEGER NOT NULL,
          'tx.index' INTEGER NOT NULL,
          'tx_result.events.index' INTEGER NOT NULL,

          'meta.dex.pair' INTEGER NOT NULL,

          'HighestTick0' INTEGER,
          'LowestTick1' INTEGER,
          'LastTick' INTEGER NOT NULL,

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
            ('tx_result.events.index')
          REFERENCES
            'tx_result.events'('index'),

          FOREIGN KEY
            ('meta.dex.pair')
          REFERENCES
            'dex.pairs'('id')
        );
      `)
    );
    // add unique index constraint
    promises.push(
      db.run(sql`
        CREATE UNIQUE INDEX
          'derived.tx_price_data--block.header.height,tx.index,tx_result.events.index'
        ON
          'derived.tx_price_data' (
            'block.header.height',
            'tx.index',
            'tx_result.events.index'
          );
      `)
    );
    // add index for quick timeseries lookups, ie. lookup by pair id and then time
    promises.push(
      db.run(sql`
        CREATE INDEX
          'derived.tx_price_data--meta.dex.pair,block.header.time_unix'
        ON
          'derived.tx_price_data' (
            'meta.dex.pair',
            'block.header.time_unix'
          );
      `)
    );
  });

  return await Promise.all(promises);
}
