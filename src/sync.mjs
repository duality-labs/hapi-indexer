import ingestTxs from './storage/sqlite3/ingest/tx.mjs';

const { RPC_API='' } = process.env;

async function iterateThroughPages(readPage) {

  let currentPage;
  let currentItemCount = 0;
  let previousItemCount = 0;
  do {
    const [pageItemCount, totalItemCount, nextPage] = await readPage({ page: currentPage });

    // update progress
    previousItemCount = currentItemCount;
    currentItemCount += pageItemCount;
    currentPage = nextPage;

    // see progress
    console.log(` import progress: ${Math.round(100*currentItemCount/totalItemCount).toFixed(0).padStart(3, ' ')}%`);
  } while (currentItemCount > previousItemCount && !!currentPage);

};

export async function catchUp () {

  // read transaction pages
  await iterateThroughPages(async ({ page = 1 }) => {
    // we default starting page to 1 as this API has 1-based page numbers
    const itemsPerPage = 100;
    const response = await fetch(`${RPC_API}/tx_search?query="tx.height>=0"&page=${page}&per_page=${itemsPerPage}`);
    const { result } = await response.json();
    const { txs: pageItems, total_count: totalItemCount } = result;

    // ingest list
    await ingestTxs(pageItems);

    // return next page information for page iterating function
    const currentItemCount = (page - 1) * itemsPerPage + pageItems.length;
    const nextPage = currentItemCount < totalItemCount ? page + 1 : null;
    return [pageItems.length, totalItemCount, nextPage];
  });

};

export async function keepUp () {

};
