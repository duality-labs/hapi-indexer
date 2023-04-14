import ingestBlocks from './storage/sqlite3/ingest/block.mjs';
import ingestTxs from './storage/sqlite3/ingest/tx.mjs';

const { RPC_API='' } = process.env;

async function iterateThroughPages(readPage, label='') {

  let lastProgress;
  let lastProgressTime = 0;
  function printProgress(fraction, forcePrint) {
    // add special line for start of import
    if (!fraction) {
      console.log(`${label} import staring`);
      lastProgressTime = Date.now();
      return;
    }
    const progress = (100 * fraction).toFixed(1);
    if (forcePrint || (progress !== lastProgress && Date.now() - lastProgressTime > 1000)) {
      console.log(`${label} import progress: ${progress.padStart(3, ' ')}%`);
      lastProgress = progress;
      lastProgressTime = Date.now();
    }
  }

  let currentPage;
  let currentItemCount = 0;
  let previousItemCount = 0;

  printProgress(0);
  do {
    // read page data and return counting details
    const [pageItemCount, totalItemCount, nextPage] = await readPage({ page: currentPage });

    // update progress
    previousItemCount = currentItemCount;
    currentItemCount += pageItemCount;
    currentPage = nextPage;

    // see progress
    printProgress(currentItemCount / totalItemCount);
  } while (currentItemCount > previousItemCount && !!currentPage);
  printProgress(1, true);
};

export async function catchUp ({ fromBlockHeight = 0 }={}) {

  // read block pages
  await iterateThroughPages(async ({ page = 1 }) => {
    // we default starting page to 1 as this API has 1-based page numbers
    // max API response page item count is 100
    const itemsPerPage = 100;
    const response = await fetch(`${RPC_API}/block_search?query="block.height>${fromBlockHeight}"&page=${page}&per_page=${itemsPerPage}&order_by="asc"`);
    const { result } = await response.json();
    const { blocks: pageItems, total_count: totalItemCount } = result;

    // ingest list
    await ingestBlocks(pageItems);

    // return next page information for page iterating function
    const currentItemCount = (page - 1) * itemsPerPage + pageItems.length;
    const nextPage = currentItemCount < totalItemCount ? page + 1 : null;
    return [pageItems.length, totalItemCount, nextPage];
  }, 'block');

  // read transaction pages
  await iterateThroughPages(async ({ page = 1 }) => {
    // we default starting page to 1 as this API has 1-based page numbers
    const itemsPerPage = 100;
    const response = await fetch(`${RPC_API}/tx_search?query="tx.height>${fromBlockHeight}"&page=${page}&per_page=${itemsPerPage}`);
    const { result } = await response.json();
    const { txs: pageItems, total_count: totalItemCount } = result;

    // ingest list
    await ingestTxs(pageItems);

    // return next page information for page iterating function
    const currentItemCount = (page - 1) * itemsPerPage + pageItems.length;
    const nextPage = currentItemCount < totalItemCount ? page + 1 : null;
    return [pageItems.length, totalItemCount, nextPage];
  }, 'transaction');

};

export async function keepUp () {

};
