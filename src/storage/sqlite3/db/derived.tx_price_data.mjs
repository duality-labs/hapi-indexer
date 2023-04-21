import logger from '../../../logger.mjs';
import db from '../db.mjs';

const camelize = s => s.replace(/-./g, x=>x[1].toUpperCase());

const derivedTxPriceData = {

  // get pair ID without know which is token0 or token1
  getSeconds: async function getSeconds(tokenA, tokenB, givenQuery={}) {
    let nextKey;
    try {
      nextKey = JSON.parse(
        Buffer.from(givenQuery['next-key'], 'base64url').toString('utf8')
      );
    }
    catch (e) {
      logger.error(e);
    }
    // convert kebabe case keys and string values
    // to camel case keys and numeric values
    // eg { "page-size": "100" }
    const numericQuery = Object.entries(nextKey || givenQuery || {}).reduce((query, [key, value]) => {
      query[camelize(key)] = Number(value) || undefined;
      return query;
    }, {});

    const query = {
      offset: Math.max(0, numericQuery.offset ?? 0),
      pageSize: Math.min(1000, numericQuery.pageSize ?? 100),
      before: numericQuery.before ?? Math.floor(Date.now() / 1000),
      after: numericQuery.after ?? 0,
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
        AND 'derived.tx_price_data'.'block.header.time_unix' <= ?
        AND 'derived.tx_price_data'.'block.header.time_unix' >= ?
      ORDER BY
        'derived.tx_price_data'.'block.header.time_unix' DESC,
        'derived.tx_price_data'.'tx_result.events.index' DESC
      LIMIT ?
      OFFSET ?
    `);

    // wrap response in a promise
    const data = await new Promise((resolve, reject) => {
      this._getSeconds_query.all([
        // 'token0' TEXT NOT NULL,
        tokenA,
        // 'token1' TEXT NOT NULL,
        tokenB,
        // 'token1' TEXT NOT NULL,
        tokenA,
        // 'token0' TEXT NOT NULL,
        tokenB,
        // 'block.header.time_unix' INTEGER NOT NULL,
        query.before,
        // 'block.header.time_unix' INTEGER NOT NULL,
        query.after,
        // page size
        query.pageSize,
        // offset
        query.offset,
      ], (err, result) => err ? reject(err) : resolve(result || []));
    });

    return {
      data,
      pagination: {
        'next-key': Buffer.from(
          JSON.stringify({
            'offset': query.offset + data.length,
            'page-size': query.pageSize,
            // pass height queries back in exactly as it came
            // (for consistent processing)
            ...givenQuery['before'] && {
              'before': givenQuery['before'],
            },
            ...givenQuery['after'] && {
              'after': givenQuery['after'],
            },
          })
        ).toString('base64url'),
      },
    }
  },

}

export default derivedTxPriceData;
