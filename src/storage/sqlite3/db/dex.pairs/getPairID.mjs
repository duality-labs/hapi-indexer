import db from '../../db.mjs';

// get pair ID without know which is token0 or token1
export default async function getPairID(tokenA, tokenB) {

  // wrap response in a promise
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT 'dex.pairs'.'id' FROM 'dex.pairs' WHERE (
        'dex.pairs'.'token0' = ? AND
        'dex.pairs'.'token1' = ?
      ) OR (
        'dex.pairs'.'token1' = ? AND
        'dex.pairs'.'token0' = ?
      )
    `, [
      // 'token0' TEXT NOT NULL,
      tokenA,
      // 'token1' TEXT NOT NULL,
      tokenB,
      // 'token1' TEXT NOT NULL,
      tokenA,
      // 'token0' TEXT NOT NULL,
      tokenB,
    ], (err, result) => {
      if (err) {
        return reject(err);
      }
      // return found id
      const id = result?.['id'];
      if (id) {
        return resolve(id);
      }
    });
  });
}
