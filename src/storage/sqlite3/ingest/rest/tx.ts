import sql from 'sql-template-strings';
import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';
import { Event as TxEvent } from 'cosmjs-types/tendermint/abci/types';

import db from '../../db/db';

// transform given events
//   eg. { attributes: [{ key: "dHlwZQ==", value: "bWVzc2FnZQ==", index: true }] }
// into events with attributes that have been decoded and mapped into an easy to use object
//   eg. { attributes: { type: "message" } }
interface DecodedAttributeMap {
  [key: string]: string;
}
interface DecodedTxEvent extends Omit<TxEvent, 'attributes'> {
  index: number;
  attributes: DecodedAttributeMap;
}

function translateEvents({ type, attributes }: TxEvent, index: number): DecodedTxEvent {
  return {
    index,
    type,
    attributes: attributes.reduce<DecodedAttributeMap>((acc, { key, value }) => {
      if (key) {
        const decodedKey = Buffer.from(`${key}`, 'base64').toString('utf8');
        const decodedValue = value ? Buffer.from(`${value}`, 'base64').toString('utf8') : null;
        if (decodedKey) {
          acc[decodedKey] = decodedValue || '';
        }
      }
      return acc;
    }, {}),
  };
}

async function insertBlockRows(tx_result: TxResponse) {
  // activate at run time (after db has been initialized)
  return await db.run(sql`
    INSERT OR IGNORE INTO 'block' (
      'header.height',
      'header.time',
      'header.time_unix'
    ) values (
      ${tx_result.height},
      ${tx_result.timestamp},
      ${getBlockTimeFromTxResult(tx_result)}
    )
  `);
}

async function insertDexTokensRows(txEvent: DecodedTxEvent): Promise<void> {
  // if event has tokens, ensure these tokens are present in the DB
  const tokens = [
    txEvent.attributes.Token0,
    txEvent.attributes.Token1,
    txEvent.attributes.TokenIn,
    txEvent.attributes.TokenOut,
    txEvent.attributes.Token,
  ]
    .filter(Boolean) // remove falsy
    .reduce<string[]>((acc, token) => (acc.includes(token) ? acc : acc.concat(token)), []); // remove duplicates
  // loop through all found
  if (tokens.length > 0) {
    await Promise.all(
      tokens.map(async (token) => {
        const { id } =
          (await db.get<{ id: number }>(sql`
            SELECT 'dex.tokens'.'id' FROM 'dex.tokens' WHERE (
              'dex.tokens'.'token' = ${token}
            )
          `)) || {};
        if (id) {
          return id;
        }
        // or insert new token
        const { lastID } =
          (await db.run(sql`
            INSERT INTO 'dex.tokens' ('token') values (${token})
          `)) || {};
        if (!lastID) {
          throw new Error('unable to insert dex.tokens id');
        }
        return lastID;
      })
    );
  }
}

async function insertDexPairsRows(txEvent: DecodedTxEvent): Promise<number | undefined> {
  // if event has tokens, ensure these tokens are present in the DB
  if (txEvent.attributes.Token0 && txEvent.attributes.Token1) {
    const { id } =
      (await db.get<{ id: number }>(sql`
        SELECT 'dex.pairs'.'id' FROM 'dex.pairs' WHERE (
          'dex.pairs'.'token0' = ${txEvent.attributes.Token0} AND
          'dex.pairs'.'token1' = ${txEvent.attributes.Token1}
        )
      `)) || {};

    if (id) {
      return id;
    }

    // or insert new token
    const { lastID } =
      (await db.run(sql`
        INSERT INTO 'dex.pairs' (
          'token0',
          'token1'
        ) values (
          ${txEvent.attributes.Token0},
          ${txEvent.attributes.Token1}            
        )
      `)) || {};
    if (!lastID) {
      throw new Error('unable to insert dex.pairs id');
    }
    return lastID;
  }
}

function getBlockTimeFromTxResult(tx_result: TxResponse) {
  // activate at run time (after db has been initialized)
  return Math.round(new Date(tx_result.timestamp).valueOf() / 1000);
}

async function insertTxRows(tx_result: TxResponse, index: number) {
  return await db.run(sql`
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
    ) values (
      ${tx_result.height},
      ${getBlockTimeFromTxResult(tx_result)},
      ${tx_result.txhash},
      ${index},
      ${tx_result.code},
      ${tx_result.data},
      ${tx_result.rawLog},
      ${tx_result.info},
      ${tx_result.gasWanted},
      ${tx_result.gasUsed},
      ${tx_result.codespace}
    )
  `);
}

async function insertTxEventRows(tx_result: TxResponse, txEvent: DecodedTxEvent, index: number) {
  const isDexMessage =
    tx_result.code === 0 &&
    txEvent.attributes.module === 'dex' &&
    (txEvent.type === 'message' || txEvent.type === 'TickUpdate');
  const dexPairId =
    isDexMessage && txEvent.attributes.Token0 && txEvent.attributes.Token1
      ? await insertDexPairsRows(txEvent)
      : undefined;

  const blockTime = getBlockTimeFromTxResult(tx_result);
  const { lastID } = await db.run(sql`
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
    ) values (
      ${tx_result.height},
      ${blockTime},
      ${index},
      ${tx_result.code},

      ${txEvent.index},
      ${txEvent.type},
      ${JSON.stringify(txEvent.attributes)},

      ${isDexMessage && txEvent.attributes.action === 'Swap' && dexPairId},
      ${isDexMessage && txEvent.attributes.action === 'Deposit' && dexPairId},
      ${isDexMessage && txEvent.attributes.action === 'Withdraw' && dexPairId}
    )`);
  // continue logic for several dex events
  // add event row to specific event table:
  if (isDexMessage && txEvent.attributes.action === 'TickUpdate') {
    await db.run(sql`
      INSERT INTO 'event.TickUpdate' (
        'block.header.height',
        'block.header.time_unix',
        'tx.index',
        'tx_result.events.index',

        'Token0',
        'Token1',
        'Token',
        'TickIndex',
        'Reserves',

        'meta.dex.pair',
        'meta.dex.token'
      ) values (
        ${tx_result.height},
        ${blockTime},
        ${index},
        ${txEvent.index},

        ${txEvent.attributes['Token0']},
        ${txEvent.attributes['Token1']},
        ${txEvent.attributes['TokenIn']},
        ${txEvent.attributes['TickIndex']},
        ${txEvent.attributes['Reserves']},
        ${dexPairId},
        ${
          // get token ID
          await db
            .get(
              sql`
                SELECT 'dex.tokens'.'id' FROM 'dex.tokens' WHERE (
                  'dex.tokens'.'token' = ${txEvent.attributes['TokenIn']}
                )
              `
            )
            .then((row) => row?.['id'])
        }
      )
    `);
    // add derivations of TickUpdates before resolving
    await upsertDerivedTickStateRows(tx_result, txEvent, index);
  } else if (isDexMessage && txEvent.attributes.action === 'Swap') {
    await db.run(sql`
      INSERT INTO 'event.Swap' (
        'block.header.height',
        'block.header.time_unix',
        'tx.index',
        'tx_result.events.index',

        'Creator',
        'Receiver',
        'Token0',
        'Token1',
        'TokenIn',
        'TokenOut',
        'AmountIn',
        'AmountOut',

        'meta.dex.pair',
        'meta.dex.tokenIn',
        'meta.dex.tokenOut'
      ) values (
        ${tx_result.height},
        ${blockTime},
        ${index},
        ${txEvent.index},

        ${txEvent.attributes['Creator']},
        ${txEvent.attributes['Receiver']},
        ${txEvent.attributes['Token0']},
        ${txEvent.attributes['Token1']},
        ${txEvent.attributes['TokenIn']},
        ${
          txEvent.attributes['TokenIn'] !== txEvent.attributes['Token0']
            ? txEvent.attributes['Token0']
            : txEvent.attributes['Token1']
        },
        ${txEvent.attributes['AmountIn']},
        ${txEvent.attributes['AmountOut']},

        ${dexPairId},
        ${
          // todo: this is inconsistent with other queries
          // it should be converted into a sub query
          // get token in ID
          await db
            .get(
              sql`
                SELECT 'dex.tokens'.'id' FROM 'dex.tokens' WHERE (
                  'dex.tokens'.'token' = ${txEvent.attributes['TokenIn']}
                )
              `
            )
            .then((row) => row?.['id'])
        },
        ${
          // get token out ID
          await db
            .get(
              sql`
                SELECT 'dex.tokens'.'id' FROM 'dex.tokens' WHERE (
                  'dex.tokens'.'token' = ${
                    txEvent.attributes['TokenIn'] !== txEvent.attributes['Token0']
                      ? txEvent.attributes['Token0']
                      : txEvent.attributes['Token1']
                  }
                )
              `
            )
            .then((row) => row['id'])
        }
      )
    `);
  } else if (isDexMessage && txEvent.attributes.action === 'Deposit') {
    await db.run(sql`
      INSERT INTO 'event.Deposit' (
        'block.header.height',
        'block.header.time_unix',
        'tx.index',
        'tx_result.events.index',

        'Creator',
        'Receiver',
        'Token0',
        'Token1',
        'TickIndex',
        'Fee',
        'Reserves0Deposited',
        'Reserves1Deposited',
        'SharesMinted',

        'meta.dex.pair'
      ) values (
        ${tx_result.height},
        ${blockTime},
        ${index},
        ${txEvent.index},
        ${txEvent.attributes['Creator']},
        ${txEvent.attributes['Receiver']},
        ${txEvent.attributes['Token0']},
        ${txEvent.attributes['Token1']},
        ${txEvent.attributes['TickIndex']},
        ${txEvent.attributes['Fee']},
        ${txEvent.attributes['Reserves0Deposited']},
        ${txEvent.attributes['Reserves1Deposited']},
        ${txEvent.attributes['SharesMinted']},
        ${dexPairId}
      )
    `);
  } else if (isDexMessage && txEvent.attributes.action === 'Withdraw') {
    await db.run(sql`
      INSERT INTO 'event.Withdraw' (
        'block.header.height',
        'block.header.time_unix',
        'tx.index',
        'tx_result.events.index',

        'Creator',
        'Receiver',
        'Token0',
        'Token1',
        'TickIndex',
        'Fee',
        'Reserves0Withdrawn',
        'Reserves1Withdrawn',
        'SharesRemoved',

        'meta.dex.pair'
      ) values (
        ${tx_result.height},
        ${blockTime},
        ${index},
        ${txEvent.index},
        ${txEvent.attributes['Creator']},
        ${txEvent.attributes['Receiver']},
        ${txEvent.attributes['Token0']},
        ${txEvent.attributes['Token1']},
        ${txEvent.attributes['TickIndex']},
        ${txEvent.attributes['Fee']},
        ${txEvent.attributes['Reserves0Withdrawn']},
        ${
          txEvent.attributes['Reserves1Withdrawn'] || '0' // hack fix because Reserves1Withdrawn is never emitted
        },
        ${txEvent.attributes['SharesRemoved']},
        ${dexPairId}
      )
    `);
  }
  return lastID;
}

async function upsertDerivedTickStateRows(
  tx_result: TxResponse,
  txEvent: DecodedTxEvent,
  index: number
) {
  const isDexMessage =
    txEvent.type === 'TickUpdate' && txEvent.attributes.module === 'dex' && tx_result.code === 0;

  if (isDexMessage && txEvent.attributes.action === 'TickUpdate') {
    const blockTime = getBlockTimeFromTxResult(tx_result);

    const { lastID } = await db.run(sql`
      INSERT OR REPLACE INTO 'derived.tick_state' (
        'meta.dex.pair',
        'meta.dex.token',
        'TickIndex',
        'Reserves'
      ) values (
        (
          SELECT 'dex.pairs'.'id' FROM 'dex.pairs' WHERE (
            'dex.pairs'.'Token0' = ${txEvent.attributes['Token0']} AND
            'dex.pairs'.'Token1' = ${txEvent.attributes['Token1']}
          )
        ),
        (
          SELECT 'dex.tokens'.'id' FROM 'dex.tokens' WHERE (
            'dex.tokens'.'Token' = ${txEvent.attributes['TokenIn']}
          )
        ),
        ${txEvent.attributes['TickIndex']},
        ${txEvent.attributes['Reserves']}
      )
    `);

    // continue logic for several dependent states
    const isForward = txEvent.attributes['TokenIn'] === txEvent.attributes['Token1'];
    const tickSide = isForward ? 'LowestTick1' : 'HighestTick0';
    // note that previousTickIndex may not exist yet
    const previousPriceData = await db.get(sql`
      SELECT 'derived.tx_price_data'.'HighestTick0', 'derived.tx_price_data'.'LowestTick1' FROM 'derived.tx_price_data' WHERE (
        'derived.tx_price_data'.'meta.dex.pair' = (
          SELECT 'dex.pairs'.'id' FROM 'dex.pairs' WHERE (
            'dex.pairs'.'Token0' = ${txEvent.attributes['Token0']} AND
            'dex.pairs'.'Token1' = ${txEvent.attributes['Token1']}
          )
        )
      )
      ORDER BY
        'derived.tx_price_data'.'block.header.height' DESC,
        'derived.tx_price_data'.'tx.index' DESC,
        'derived.tx_price_data'.'tx_result.events.index' DESC
      LIMIT 1
    `);
    const previousTickIndex = previousPriceData?.[tickSide];

    // derive data from entire ticks state (useful for maybe some other calculations)
    const currentTickIndex = await db
      .get(
        // append plain SQL (without value substitution) to have conditional query
        sql`
          SELECT 'derived.tick_state'.'TickIndex' FROM 'derived.tick_state' WHERE (
            'derived.tick_state'.'meta.dex.pair' = (
              SELECT 'dex.pairs'.'id' FROM 'dex.pairs' WHERE (
                'dex.pairs'.'Token0' = ${txEvent.attributes['Token0']} AND
                'dex.pairs'.'Token1' = ${txEvent.attributes['Token1']}
              )
            )
            AND
            'derived.tick_state'.'meta.dex.token' = (
              SELECT 'dex.tokens'.'id' FROM 'dex.tokens' WHERE (
                'dex.tokens'.'Token' = ${txEvent.attributes['TokenIn']}
              )
            )
            AND
            'derived.tick_state'.'Reserves' != '0'
          )
        `.append(`--sql
          ORDER BY 'derived.tick_state'.'TickIndex' ${isForward ? 'ASC' : 'DESC'}
          LIMIT 1
        `)
      )
      .then((row) => row?.['TickIndex'] ?? null);

    // if activity has changed current price then update data
    if (previousTickIndex !== currentTickIndex) {
      const previousOtherSideTickIndex =
        (isForward ? previousPriceData?.['HighestTick0'] : previousPriceData?.['LowestTick1']) ??
        null;
      await db.run(sql`
        INSERT OR REPLACE INTO 'derived.tx_price_data' (
          'block.header.height',
          'block.header.time_unix',
          'tx.index',
          'tx_result.events.index',

          'meta.dex.pair',

          'HighestTick0',
          'LowestTick1',
          'LastTick'
        ) values (
          ${tx_result.height},
          ${blockTime},
          ${-index},
          ${txEvent.index},

          (
            SELECT 'dex.pairs'.'id' FROM 'dex.pairs' WHERE (
              'dex.pairs'.'Token0' = ${txEvent.attributes['Token0']} AND
              'dex.pairs'.'Token1' = ${txEvent.attributes['Token1']}
            )
          ),

          ${isForward ? previousOtherSideTickIndex : currentTickIndex},
          ${isForward ? currentTickIndex : previousOtherSideTickIndex},
          ${currentTickIndex || previousOtherSideTickIndex}
        )
      `);
    }

    return lastID;
  }
}

export default async function ingestTxs(txPage: TxResponse[]) {
  return await promiseMapInSeries(txPage, async (tx_result: TxResponse, index: number) => {
    const txEvents = (tx_result.events || []).map(translateEvents);
    // first add block rows
    await insertBlockRows(tx_result);
    // then add token foreign keys
    await promiseMapInSeries(txEvents, insertDexTokensRows);
    // then add token foreign keys
    await promiseMapInSeries(txEvents, insertDexPairsRows);
    // then add transaction rows
    await insertTxRows(tx_result, index);
    // then add transaction event rows
    await promiseMapInSeries(txEvents, async (txEvent: DecodedTxEvent) => {
      await insertTxEventRows(tx_result, txEvent, index);
    });
  });
}

async function promiseMapInSeries<T>(
  list: Array<T>,
  itemCallback: (item: T, index: number, list: T[]) => Promise<unknown>
) {
  return list.reduce<Promise<unknown[]>>(async (listPromise, item, index) => {
    return Promise.all([...(await listPromise), itemCallback(item, index, list)]);
  }, new Promise((resolve) => resolve([])));
}
