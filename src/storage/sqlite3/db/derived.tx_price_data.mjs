import db from '../db.mjs';

const derivedTxPriceData = {

  // get pair ID without know which is token0 or token1
  getSeconds: async function getSeconds(tokenA, tokenB, query={}) {
    const pageSize = Number(query['page-size']) || 100;
    const offset = Number(query['offset']) || 0;
    const fromHeight = Number(query['from-height']) || Math.pow(2, 31) - 1;
    const toHeight = Number(query['to-height']) || 0;
    const adjusted = {
      fromHeight: fromHeight > toHeight ? fromHeight : toHeight,
      toHeight: fromHeight > toHeight ? toHeight: fromHeight,
    };

    // prepare statement at run time (after db has been initialized)
    this._getSeconds_query = this._getSeconds_query || db.prepare(`
      SELECT
        'derived.tx_price_data'.'block.header.time_unix' as 'time_unix',
        'derived.tx_price_data'.'LastTick' as 'last_price'
      FROM
        'derived.tx_price_data'
      WHERE
        'derived.tx_price_data'.'meta.dex.pair' = (
          SELECT 'dex.pairs'.'id' FROM 'dex.pairs' WHERE (
            'dex.pairs'.'token0' = ? AND
            'dex.pairs'.'token1' = ?
          ) OR (
            'dex.pairs'.'token1' = ? AND
            'dex.pairs'.'token0' = ?
          )
        )
        AND 'derived.tx_price_data'.'block.header.height' <= ?
        AND 'derived.tx_price_data'.'block.header.height' >= ?
      ORDER BY
        'derived.tx_price_data'.'block.header.height' DESC,
        'derived.tx_price_data'.'tx_result.events.index' DESC
      LIMIT ?
      OFFSET ?
    `);

    // wrap response in a promise
    return new Promise((resolve, reject) => {
      this._getSeconds_query.all([
        // 'token0' TEXT NOT NULL,
        tokenA,
        // 'token1' TEXT NOT NULL,
        tokenB,
        // 'token1' TEXT NOT NULL,
        tokenA,
        // 'token0' TEXT NOT NULL,
        tokenB,
        // 'block.header.height' INTEGER NOT NULL,
        adjusted.fromHeight,
        // 'block.header.height' INTEGER NOT NULL,
        adjusted.toHeight,
        // page size
        pageSize,
        // offset
        offset,
      ], (err, result) => err ? reject(err) : resolve(result));
    });
  },

}

export default derivedTxPriceData;
