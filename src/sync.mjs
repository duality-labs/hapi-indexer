import { createLogger, transports, config, format } from 'winston';
import { logFileTransport } from './logger.mjs';

import ingestBlocks from './storage/sqlite3/ingest/rpc/block.mjs';
import ingestRpcTxs from './storage/sqlite3/ingest/rpc/tx.mjs';
import ingestRestTxs from './storage/sqlite3/ingest/rest/tx.mjs';

const { RPC_API='', REST_API='', POLLING_INTERVAL_SECONDS='' } = process.env;

const pollIntervalTimeSeconds = Number(POLLING_INTERVAL_SECONDS) || 5;

const defaultLogger = createLogger({
  levels: config.npm.levels,
  format: format.combine(
    format((log) => {
        if (log.label) {
          log.message = `${log.label} ${log.message}`;
          delete log.label;
        }
        return log;
    })(),
    format.colorize(),
    format.simple(),
  ),
  transports: [
    new transports.Console(),
    logFileTransport,
  ]
});

const pollingLogger = createLogger({
  levels: config.npm.levels,
  format: format(({ message }) => ({ message }))(),
  transports: [
    new transports.Console({ level: 'warn' }),
    logFileTransport,
  ],
});

async function iterateThroughPages(readPage, logger) {
  let lastProgressTime = 0;
  function printProgress(numerator, divisor, message) {
    if (message || (Date.now() - lastProgressTime > 1000)) {
      logger.info(message || `import progress: ${(100 * numerator / divisor).toFixed(1).padStart(5, ' ')}% (${numerator} items)`);
      lastProgressTime = Date.now();
    }
  }

  let currentPage;
  let currentItemCount = 0;
  let previousItemCount = 0;

  printProgress(0, 1, 'import starting');
  do {
    // read page data and return counting details
    const [pageItemCount, totalItemCount, nextPage] = await readPage({ page: currentPage });

    // update progress
    previousItemCount = currentItemCount;
    currentItemCount += pageItemCount;
    currentPage = nextPage;

    // see progress
    printProgress(currentItemCount, totalItemCount);
  } while (currentItemCount > previousItemCount && !!currentPage);
  printProgress(1, 1, 'import done');
};

let maxBlockHeight = 0;
async function catchUpRPC ({ fromBlockHeight = 0, logger = defaultLogger }={}) {

  const totalBlockCount = await fetch(`${RPC_API}/abci_info`)
    .then(response => response.json())
    .then(({ result }) => Number(result.response.last_block_height) - fromBlockHeight);

  // read block pages
  await iterateThroughPages(async ({ page = 1 }) => {
    // we default starting page to 1 as this API has 1-based page numbers
    // max API response page item count is 100
    const itemsPerPage = 100;
    const heightStart = (page - 1) * itemsPerPage + fromBlockHeight;
    const heightEnd = page * itemsPerPage + fromBlockHeight;
    const blockQuery = `block.height>${heightStart}+AND+block.height<=${heightEnd}`;
    const response = await fetch(`${RPC_API}/block_search?query="${blockQuery}"&page=1&per_page=${itemsPerPage}&order_by="asc"`);
    const { result } = await response.json();
    const { blocks: pageItems } = result;

    // take note of the maximum block height stored so far
    const lastBlockHeight = Number(pageItems[pageItems.length - 1]?.block?.header?.height);
    if (lastBlockHeight > maxBlockHeight) {
      maxBlockHeight = lastBlockHeight;
    }

    // ingest list
    await ingestBlocks(pageItems);

    // return next page information for page iterating function
    const currentItemCount = (page - 1) * itemsPerPage + pageItems.length;
    const nextPage = currentItemCount < totalBlockCount ? page + 1 : null;
    return [pageItems.length, totalBlockCount, nextPage];
  }, logger.child({ label: 'block' }));

  // read transaction pages
  await iterateThroughPages(async ({ page = 1 }) => {
    // we default starting page to 1 as this API has 1-based page numbers
    const itemsPerPage = 100;
    const response = await fetch(`${RPC_API}/tx_search?query="tx.height>${fromBlockHeight}"&page=${page}&per_page=${itemsPerPage}`);
    const { result } = await response.json();
    const { txs: pageItems, total_count: totalItemCount } = result;

    // ingest list
    await ingestRpcTxs(pageItems);

    // return next page information for page iterating function
    const currentItemCount = (page - 1) * itemsPerPage + pageItems.length;
    const nextPage = currentItemCount < totalItemCount ? page + 1 : null;
    return [pageItems.length, totalItemCount, nextPage];
  }, logger.child({ label: 'transaction' }));

};

export async function keepUpRPC () {

  defaultLogger.info(`keeping up: polling from block height: ${maxBlockHeight}`)

  // poll for updates
  async function poll() {

    defaultLogger.info(`keeping up: polling`);
    const lastBlockHeight = maxBlockHeight;
    await catchUpRPC({ fromBlockHeight: maxBlockHeight, logger: pollingLogger });

    // log block height increments
    if (maxBlockHeight > lastBlockHeight) {
      for (let i = lastBlockHeight + 1; i <= maxBlockHeight; i += 1) {
        defaultLogger.info(`keeping up: new block processed: ${i}`);
      }
    }

    // poll again after a certain amount of time has passed
    // note: prefer setTimeout over setInterval because of concerns about
    // overlapping ingestions into the DB (ie. if ingestion takes longer than
    // the setInterval time then multiple invocations of catchUp will run concurrently)
    setTimeout(poll, 1000 * pollIntervalTimeSeconds);
  }

  poll();
};

async function catchUpREST ({ fromBlockHeight = 0, logger = defaultLogger }={}) {

  // read tx pages
  await iterateThroughPages(async ({ page: offset=0 }) => {
    // we default starting page to 1 as this API has 1-based page numbers
    // max API response page item count is 100
    const itemsPerPage = 100;
    const response = await fetch(`
      ${REST_API}/cosmos/tx/v1beta1/txs
        ?events=tx.height>=${fromBlockHeight}
        ${offset ? `&pagination.offset=${offset}` : ''}
        &pagination.limit=${itemsPerPage}
        &pagination.count_total=true
        &order_by=ORDER_BY_ASC
    `.replace(/\s+/g, '')); // remove spaces from URL
    const { pagination, txs=[], tx_responses: pageItems = [] } = await response.json();

    const lastItemBlockHeight = Number(pageItems.slice(-1).pop()?.['height']);
    if (lastItemBlockHeight) {
      maxBlockHeight = lastItemBlockHeight;
    }

    // ingest list
    await ingestRestTxs(pageItems);
    // return next page information for page iterating function
    const pageItemCount = txs.length;
    const totalItemCount = (pagination?.total && Number(pagination.total)) || 0;
    const currentItemCount = offset + pageItemCount;
    const nextOffset = currentItemCount < totalItemCount ? currentItemCount: null;
    return [pageItemCount, totalItemCount, nextOffset];
  }, logger.child({ label: 'transaction' }));
};

export async function keepUpREST () {

  defaultLogger.info(`keeping up: polling from block height: ${maxBlockHeight}`)

  // poll for updates
  async function poll() {

    defaultLogger.info(`keeping up: polling`);
    const lastBlockHeight = maxBlockHeight;
    await catchUpREST({ fromBlockHeight: maxBlockHeight + 1, logger: pollingLogger });

    // log block height increments
    if (maxBlockHeight > lastBlockHeight) {
      defaultLogger.info(`keeping up: last block processed: ${maxBlockHeight}`);
    }

    // poll again after a certain amount of time has passed
    // note: prefer setTimeout over setInterval because of concerns about
    // overlapping ingestions into the DB (ie. if ingestion takes longer than
    // the setInterval time then multiple invocations of catchUp will run concurrently)
    setTimeout(poll, 1000 * pollIntervalTimeSeconds);
  }

  poll();
};

// choose method to use to catch up to the chain with
export { catchUpREST as catchUp }
export { keepUpREST as keepUp }
