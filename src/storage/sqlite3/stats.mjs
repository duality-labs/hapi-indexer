import BigNumber from 'bignumber.js';

import db from './db.mjs'

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

export async function volume({ lastDays, lastSeconds = lastDays * 24 * 60 * 60 }) {

  const unixNow = Math.round(Date.now() / 1000);
  const unixStart = unixNow - lastSeconds;

  return new Promise((resolve, reject) => {
    db.all(`
      SELECT * FROM 'tx_result.events'
        WHERE ('tx_result.events'.'block.header.time_unix' > ?)
    `, [unixStart], (err, rows) => {
        if (err) reject(err);
        resolve(
          // find the volume traded within these events
          rows.reduce((acc, row) => {
            return acc.plus(JSON.parse(row.attributes)?.['AmountIn'] ?? '0')
          }, new BigNumber(0))
        );
    });
  });
}
