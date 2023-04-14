import { createLogger, transports, config, format } from 'winston';
import { logFileTransport } from './logger.mjs';

import ingestBlocks from './storage/sqlite3/ingest/block.mjs';
import ingestTxs from './storage/sqlite3/ingest/tx.mjs';

const { RPC_API='', POLLING_INTERVAL_SECONDS='' } = process.env;

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
  let lastProgress;
  let lastProgressTime = 0;
  function printProgress(fraction, forcePrint) {
    const progress = (100 * fraction).toFixed(1);
    if (forcePrint || (progress !== lastProgress && Date.now() - lastProgressTime > 1000)) {
      // add special lines for start and end of import
      if (fraction === 0) {
        logger.info('import starting');
      }
      else if (fraction === 1) {
        logger.info('import done');
      }
      else {
        logger.info(`import progress: ${progress.padStart(3, ' ')}%`);
      }
      lastProgress = progress;
      lastProgressTime = Date.now();
    }
  }

  let currentPage;
  let currentItemCount = 0;
  let previousItemCount = 0;

  printProgress(0, true);
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

let maxBlockHeight = 0;
export async function catchUp ({ fromBlockHeight = 0, logger = defaultLogger }={}) {

  // read block pages
  await iterateThroughPages(async ({ page = 1 }) => {
    // we default starting page to 1 as this API has 1-based page numbers
    // max API response page item count is 100
    const itemsPerPage = 100;
    const response = await fetch(`${RPC_API}/block_search?query="block.height>${fromBlockHeight}"&page=${page}&per_page=${itemsPerPage}&order_by="asc"`);
    const { result } = await response.json();
    const { blocks: pageItems, total_count: totalItemCount } = result;

    // take note of the maximum block height stored so far
    const lastBlockHeight = Number(pageItems[pageItems.length - 1]?.block?.header?.height);
    if (lastBlockHeight > maxBlockHeight) {
      maxBlockHeight = lastBlockHeight;
    }

    // ingest list
    await ingestBlocks(pageItems);

    // return next page information for page iterating function
    const currentItemCount = (page - 1) * itemsPerPage + pageItems.length;
    const nextPage = currentItemCount < totalItemCount ? page + 1 : null;
    return [pageItems.length, totalItemCount, nextPage];
  }, logger.child({ label: 'block' }));

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
  }, logger.child({ label: 'transaction' }));

};

export async function keepUp () {

  defaultLogger.info(`keeping up: polling from block height: ${maxBlockHeight}`)

  // poll for updates
  async function poll() {

    defaultLogger.info(`keeping up: polling`);
    const lastBlockHeight = maxBlockHeight;
    await catchUp({ fromBlockHeight: maxBlockHeight, logger: pollingLogger });

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
