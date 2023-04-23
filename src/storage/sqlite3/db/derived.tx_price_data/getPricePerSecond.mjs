import logger from '../../../../logger.mjs';
import db from '../../db.mjs';

const camelize = s => s.replace(/-./g, x=>x[1].toUpperCase());

export default async function getPricePerSecond(tokenA, tokenB, query={}) {
  // use pagination key to replace any other pagination options requested
  try {
    if (query.pagination?.['key']) {
      query.pagination = JSON.parse(
        Buffer.from(query.pagination?.['key'], 'base64url').toString('utf8')
      );
    }
  }
  catch (e) {
    logger.error(e);
  }
  // convert kebabe case keys and string values
    // to camel case keys and numeric values
    // eg { "page-size": "100" }
  const unsafePagination = Object.entries(query.pagination || {})
    .reduce((query, [key, value]) => {
      query[camelize(key)] = Number(value) || undefined;
      return query;
    }, {});

  // ensure some basic pagination limits are respected
  const pagination = {
    offset: Math.max(0, unsafePagination.offset ?? 0),
    limit: Math.min(1000, unsafePagination.limit ?? 100),
    before: unsafePagination.before ?? Math.floor(Date.now() / 1000),
    after: unsafePagination.after ?? 0,
  };

  // prepare statement at run time (after db has been initialized)
  const preparedStatement = db.prepare(`
    WITH price_points AS (
      SELECT
        'derived.tx_price_data'.'block.header.time_unix' as 'time_unix',
        first_value('derived.tx_price_data'.'LastTick')
          OVER seconds_window as 'last_price',
        last_value('derived.tx_price_data'.'LastTick')
          OVER seconds_window as 'first_price',
        'derived.tx_price_data'.'LastTick' as 'price'
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
      WINDOW seconds_window AS (
        ORDER BY 'derived.tx_price_data'.'block.header.time_unix'
        GROUPS CURRENT ROW
      )
      ORDER BY
        'derived.tx_price_data'.'block.header.time_unix' DESC,
        'derived.tx_price_data'.'tx_result.events.index' DESC
    )
    SELECT
      'price_points'.'time_unix',
      'price_points'.'first_price' as 'open',
      'price_points'.'last_price' as 'close',
      min('price_points'.'price') as 'min',
      max('price_points'.'price') as 'max'
    FROM
      'price_points'
    GROUP BY
      'price_points'.'time_unix'
    ORDER BY
      'price_points'.'time_unix' DESC
    LIMIT ?
    OFFSET ?
  `);

  // wrap response in a promise
  const data = await new Promise((resolve, reject) => {
    preparedStatement.all([
      // 'token0' TEXT NOT NULL,
      tokenA,
      // 'token1' TEXT NOT NULL,
      tokenB,
      // 'token1' TEXT NOT NULL,
      tokenA,
      // 'token0' TEXT NOT NULL,
      tokenB,
      // 'block.header.time_unix' INTEGER NOT NULL,
      pagination.before,
      // 'block.header.time_unix' INTEGER NOT NULL,
      pagination.after,
      // page size
      // note: requesting 1 extra element to see if another page of data exists after this one
      pagination.limit + 1,
      // offset
      pagination.offset,
    ], (err, result) => err ? reject(err) : resolve(result || []));
  });

  // if result includes an item from the next page then remove it
  // and generate a next key to represent the next page of data
  const nextKey = data.length > pagination.limit
    ? data.pop() && (
      Buffer.from(
        JSON.stringify({
          'offset': pagination.offset + data.length,
          'size': pagination.limit,
          // pass height queries back in exactly as it came
          // (for consistent processing)
          ...query['pagination.before'] && {
            'before': query['pagination.before'],
          },
          ...query['pagination.after'] && {
            'after': query['pagination.after'],
          },
        })
      ).toString('base64url')
    )
    : null;

  return {
    data,
    pagination: {
      'next-key': nextKey,
    },
  }
}
