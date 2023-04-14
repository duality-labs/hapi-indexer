import ingestTxs from './storage/sqlite3/ingest/tx.mjs';

const { RPC_API='' } = process.env;

async function iterateThroughPages(readPage) {

  let currentPage = 0;
  let currentItemCount = 0;
  let previousItemCount = 0;
  let totalItemCount = 0;
  do {
    const [pageItemCount, totalItemCount, nextPage = currentPage + 1] = await readPage({ page: currentPage });

    // update progress
    previousItemCount = currentItemCount;
    currentItemCount += pageItemCount;
    totalItemCount = totalItemCount;
    currentPage = nextPage;

    // see progress
    console.log(` import progress: ${Math.round(100*currentItemCount/totalItemCount).toFixed(0).padStart(3, ' ')}%`);
  } while (currentItemCount > previousItemCount && currentItemCount < totalItemCount);

};

export async function catchUp () {

  // read transaction pages
  await iterateThroughPages(async ({ page }) => {
    const response = await fetch(`${RPC_API}/tx_search?query="tx.height>=0"&page=${page}&per_page=100`);
    const { result } = await response.json();

    // ingest all tx rows given
    await ingestTxs(result.txs);
    // return information for page iterating function
    return [result.txs.length, result.totalCount, page + 1];
  });

};

export async function keepUp () {

};
