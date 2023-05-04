import { Request, ResponseToolkit } from '@hapi/hapi';
import BigNumber from 'bignumber.js';

import db from '../../storage/sqlite3/db/db';
import logger from '../../logger';

async function volume(tokenA: string, tokenB: string, { lastDays = 1, lastSeconds = lastDays * 24 * 60 * 60 }: {
  lastDays?: number;
  lastSeconds?: number;
}) {

  const unixNow = Math.round(Date.now() / 1000);
  const unixStart = unixNow - lastSeconds;

  return await
    db.all(`--sql
      SELECT
        'event.Swap'.'block.header.time_unix',
        'event.Swap'.'AmountOut',
        'event.Swap'.'TokenOut'
      FROM 'event.Swap'
        WHERE
        'event.Swap'.'meta.dex.pair' = (
          SELECT 'dex.pairs'.'id' FROM 'dex.pairs' WHERE (
            'dex.pairs'.'token0' = ? AND
            'dex.pairs'.'token1' = ?
          ) OR (
            'dex.pairs'.'token1' = ? AND
            'dex.pairs'.'token0' = ?
          )
        )
        AND 'event.Swap'.'block.header.time_unix' > ?
    `, [
      // 'token0' TEXT NOT NULL,
      tokenA,
      // 'token1' TEXT NOT NULL,
      tokenB,
      // 'token1' TEXT NOT NULL,
      tokenA,
      // 'token0' TEXT NOT NULL,
      tokenB,
      // 'block.header.time_unix' INTEGER NOT NULL,
      unixStart,
    ])
    .then((rows=[]) => {
          return rows.reduce((acc, row) => {
            // todo: add conversion to base currency to get real total value
            return acc.plus(row['AmountOut'] ?? '0')
          }, new BigNumber(0))
    });
}

const routes = [

  {
    method: 'GET',
    path: '/stats/volume/{tokenA}/{tokenB}',
    handler: async (request: Request, h: ResponseToolkit) => {
      try {
        return {
          hours: {
            1: await volume(
              request.params['tokenA'],
              request.params['tokenB'],
              { lastSeconds: 60 * 60 }
            ),
          },
          days: {
            1: await volume(
              request.params['tokenA'],
              request.params['tokenB'],
              { lastDays: 1 }
            ),
            7: await volume(
              request.params['tokenA'],
              request.params['tokenB'],
              { lastDays: 7 }
            ),
            28: await volume(
              request.params['tokenA'],
              request.params['tokenB'],
              { lastDays: 28 }
            ),
          },
        };
      }
      catch (err: unknown) {
        if (err instanceof Error) {
          logger.error(err);
          return h.response(`something happened: ${err.message || '?'}`).code(500);  
        }
        return h.response('An unknown error occurred').code(500);  
      }
    },
  },

];

export default routes;
