import { Request, ResponseToolkit } from '@hapi/hapi';
import BigNumber from 'bignumber.js';

import db from '../../storage/sqlite3/db/db';
import logger from '../../logger';

// get volume of pair over last 7 days
// SELECT 'dex.pairs'
//   JOIN 'block' ON ('tx'.'height' = 'block'.'height')
//   JOIN 'tx' ON ('tx'.'meta.dex.pair_swap' = 'dex.pairs'.'id')
//   JOIN 'tx_result.events' ON ('tx'.'height' = 'tx_result.events'.'height' AND 'tx'.'index' = 'tx_result.events'.'index')
//   WHERE ('dex.pairs'.'token0'=?, 'dex.pairs'.'token1'=?, 'tx'.'tx_result.code'=0, 'block'.'header.time_unix'>=?)

// SELECT 'dex.pairs'
//   JOIN 'block' ON ('tx'.'height' = 'block'.'height')
//   JOIN 'tx_result.events' ON ('dex.pairs'.'id' = 'tx_result.events'.'meta.dex.pair_swap' AND 'block'.'height' = 'tx_result.events'.'tx.height')
//   WHERE ('dex.pairs'.'token0'=?, 'dex.pairs'.'token1'=?, 'tx_result.events'.'tx.tx_result.code'=0, 'block'.'header.time_unix'>=?)

// SELECT 'dex.pairs'
//   JOIN 'tx_result.events' ON ('dex.pairs'.'id' = 'tx_result.events'.'meta.dex.pair_swap')
//   WHERE ('dex.pairs'.'token0'=?, 'dex.pairs'.'token1'=?, 'tx_result.events'.'tx.tx_result.code'=0, 'tx_result.events'.'block.header.time_unix'>=?)

// then sum the appropriate JSON blob numbers

// open question: is there any way to group different requests from within the same transaction
// eg. I can deposit and withdraw on the same transaction: can those events be split into their originating action type requests??
//     - I don't think so
//     - I think it's all done to what we place in the emitted events as they don't necessarily line up
//         - eg. "NewSwap" is an emitted event action
//           but "/nicholasdotsol.duality.dex.MsgSwap" is the Msg passed in

// when you listen to a websocket response: do the events have timestamps??
//    - it could be that we have to listen to events and block creation separately (can we listen for clock timestamps through websockets)
//    - whichever way is easiest to listen for block height *and timestamps* is the way we should query and listen for data
// through REST API: - only /cosmos/tx/v1beta1/txs?events=tx.height>=0 is needed
// through  RPC API: - both /tx_search?query="tx.height>=0"
//                      and /block_search?query="block.height>=0"
//                      are needed to get events with timestamps
//                      as foreign keys are used

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
