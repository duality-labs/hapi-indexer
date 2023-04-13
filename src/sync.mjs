import ingestTxs from './storage/sqlite3/ingest/tx.mjs';

const { RPC_API='' } = process.env;

export async function catchUp () {

  let currentTxPage = 0;
  let currentTxCount = 0;
  let previousTxCount = 0;
  let totalTxCount = 0;
  do {
    currentTxPage += 1;
    const response = await fetch(`${RPC_API}/tx_search?query="tx.height>=0"&page=${currentTxPage}&per_page=100`);
    const { result } = await response.json();

    // ingest all tx rows given
    await ingestTxs(result.txs);

    // update progress
    previousTxCount = currentTxCount;
    currentTxCount += result.txs.length;
    totalTxCount = result.total_count;

    // see progress
    console.log(`tx import progress: ${Math.round(100*currentTxCount/totalTxCount).toFixed(0).padStart(3, ' ')}%`);
  } while (currentTxCount > previousTxCount && currentTxCount < totalTxCount);

};

export async function keepUp () {

};
