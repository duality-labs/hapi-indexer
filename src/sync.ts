import EventEmitter from 'events';
import { createLogger, transports, config, format, Logger } from 'winston';
import { Response } from 'undici';
import { ResponseDeliverTx } from 'cosmjs-types/tendermint/abci/types';

import { logFileTransport } from './logger';
import { TxResponse } from './@types/tx';

import ingestTxs from './storage/sqlite3/ingest/ingestTxResponse';
import { inMs, minutes, seconds } from './storage/sqlite3/db/timeseriesUtils';
import Timer from './utils/timer';

// define the snamke case that the response is actually in
interface RpcTxResult extends Omit<ResponseDeliverTx, 'gasWanted' | 'gasUsed'> {
  gas_wanted: TxResponse['gasWanted'];
  gas_used: TxResponse['gasUsed'];
}
interface RpcTxSearchResponse {
  result: {
    total_count: string;
    txs: Array<{
      hash: string;
      height: string;
      tx: string;
      tx_result: RpcTxResult;
    }>;
  };
}
interface RpcBlockHeaderLookupResponse {
  result: {
    header: {
      height: string;
      time: string;
    };
  };
}

const {
  RPC_API = '',
  POLLING_INTERVAL_MS = '',
  SYNC_PAGE_SIZE = '',
  COLOR_LOGS = '',
  FETCH_TIMEOUT = '',
} = process.env;

const pollIntervalMs = Number(POLLING_INTERVAL_MS) || 500;
const fetchTimeout = Number(FETCH_TIMEOUT) || 60 * seconds * inMs;

type PageReader = (options: {
  page?: number;
  timer: Timer;
}) => Promise<
  [pageItemCount: number, totalItemCount: number, nextOffset: number | null]
>;

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
    ...(COLOR_LOGS === 'true' ? [format.colorize()] : []),
    format.simple()
  ),
  transports: [new transports.Console(), logFileTransport],
});

const pollingLogger = createLogger({
  levels: config.npm.levels,
  format: format(({ message, level }) => ({ message, level }))(),
  transports: [new transports.Console({ level: 'warn' }), logFileTransport],
});

function formatNumber(value: number, decimalPlaces = 0, padding = 0) {
  return value
    .toLocaleString('en-US', {
      minimumFractionDigits: decimalPlaces,
      maximumFractionDigits: decimalPlaces,
    })
    .padStart(padding, ' ');
}

async function iterateThroughPages(readPage: PageReader, logger: Logger) {
  let lastProgressTime = 0;
  let lastNumerator = 0;
  function printProgress(
    numerator: number,
    divisor: number,
    message?: string,
    timer?: Timer
  ) {
    const now = Date.now();
    const elapsedTime = now - lastProgressTime;
    if (message || timer || elapsedTime > 1000) {
      // send import timing logs to console as well as file
      if (message) {
        logger.info(message);
      }
      // log all tx imports that got processed
      else if (timer?.get('processing')) {
        defaultLogger.info(
          `import progress: ${formatNumber(
            (100 * numerator) / divisor,
            1,
            5
          )}% (${formatNumber(numerator)} items) ${
            timer
              ? `(fetching: ${formatNumber(
                  timer.get('fetching') ?? 0,
                  0,
                  6
                )}ms, parsing: ${formatNumber(
                  timer.get('parsing') ?? 0,
                  0,
                  3
                )}ms, processing: ${formatNumber(
                  (timer.get('processing') ?? 0) / (numerator - lastNumerator),
                  0,
                  3
                )}ms per item)`
              : `(${formatNumber(elapsedTime, 0, 6)}ms)`
          }`
        );
        // print detailed timing info if processing occured
        if (timer?.get('processing')) {
          const timerValues = timer.getAll();
          const maxKeyLength = Math.max(
            ...timerValues.map(({ label }) => label.length)
          );
          const maxMsLength = Math.max(
            ...timerValues.map((v) => v.elapsedTime.toFixed(0).length)
          );
          const maxCalledLength = Math.max(
            ...timerValues.map((v) => v.called.toFixed(0).length)
          );

          defaultLogger.info(
            `timing:\n${timerValues
              .map(({ label, elapsedTime, called }) => {
                return `${label.padEnd(maxKeyLength)} : ${elapsedTime
                  .toFixed(2)
                  .padStart(maxMsLength + 3)}ms (called ${called
                  .toFixed(0)
                  .padStart(maxCalledLength)} times: ${(elapsedTime / called)
                  .toFixed(3)
                  .padStart(maxMsLength + 4)}ms per call)`;
              })
              .join('\n')}`
          );
        }
      }
      // log empty polling information to file but not console
      else {
        logger.info(
          `poll: (${formatNumber(numerator)} items) ${
            timer
              ? `(fetching: ${formatNumber(
                  timer.get('fetching') ?? 0,
                  0,
                  6
                )}ms, parsing: ${formatNumber(
                  timer.get('parsing') ?? 0,
                  0,
                  3
                )}ms`
              : `(${formatNumber(elapsedTime, 0, 6)}ms)`
          }`
        );
      }
      lastProgressTime = now;
      lastNumerator = numerator;
    }
  }

  let currentPage;
  let currentItemCount = 0;
  let previousItemCount = 0;

  const startTime = Date.now();
  printProgress(0, 1, 'import starting');
  do {
    const timer = new Timer();
    // read page data and return counting details
    const [pageItemCount, totalItemCount, nextPage] = await readPage({
      page: currentPage,
      timer,
    });

    // update progress
    previousItemCount = currentItemCount;
    currentItemCount += pageItemCount;
    currentPage = nextPage;

    // see progress
    printProgress(currentItemCount, totalItemCount, '', timer);
  } while (currentItemCount > previousItemCount && !!currentPage);
  const duration = Date.now() - startTime;
  printProgress(
    1,
    1,
    `import done (done in ${formatNumber(duration)}ms, ${(
      duration / (currentItemCount || 1)
    ).toFixed(1)}ms per transaction)`
  );
}

function translateTxResponse(
  { code, info, log, codespace, events, gas_wanted, gas_used }: RpcTxResult,
  {
    txhash,
    height,
    timestamp,
  }: { txhash: string; height: string; timestamp: string }
): TxResponse {
  return {
    code,
    info,
    log,
    codespace,
    events,
    gasWanted: gas_wanted,
    gasUsed: gas_used,
    height,
    timestamp,
    txhash,
  };
}

const blockTimestamps: { [height: string]: string } = {};
// restrict items per page to between 1-100, and default to 100
// note: this number should be 1 or divisible by 10
const itemsPerPage = Math.max(1, Math.min(100, Number(SYNC_PAGE_SIZE) || 100));

export async function catchUp({
  fromBlockHeight = 0,
  logger = defaultLogger,
} = {}): Promise<number> {
  let maxBlockHeight = 0;
  // read tx pages
  await iterateThroughPages(async ({ page: offset = 0, timer }) => {
    // we default starting page to 1 as this API has 1-based page numbers
    // max API response page item count is 100
    let response: Response | undefined = undefined;
    let retryCount = 0;
    let itemsToRequest = itemsPerPage;
    while (!response) {
      // back-off items to request exponentially
      // (it is possible that some chunks of transactions are very large)
      // itemsToRequest follows back-off of: 100, 10, 1, 1, 1, ..., 0
      itemsToRequest = Math.ceil(itemsPerPage / Math.pow(10, retryCount));
      // ensure that page number is a round number, because offsetting the items
      // with an RPC query requires "page" which is dependent on "per_page" size
      while (offset % itemsToRequest !== 0) {
        itemsToRequest = Math.round(itemsToRequest / 10) || 1;
      }
      if (!Number.isFinite(itemsToRequest) || itemsToRequest < 1) {
        throw new Error(`Sync rety limit exceeded, count: ${retryCount}`);
      }
      const page = Math.round(offset / itemsToRequest) + 1;
      const url = `${RPC_API}/tx_search?query="${encodeURIComponent(
        `tx.height>=${fromBlockHeight} AND message.module='dex'`
      )}"&per_page=${itemsToRequest}&page=${page}`;
      // create timer label for this request (and label for last request)
      const fetchTxsTimerLabel = `fetching:txs:try-${retryCount
        .toFixed(0)
        .padStart(3, '0')}:last`;
      try {
        timer.start(fetchTxsTimerLabel);
        response = await new Promise((resolve, reject) => {
          const controller = new AbortController();
          const signal = controller.signal;
          // add a time limit for fetching, and increase it on each retry
          const delay = fetchTimeout * (retryCount + 1);
          const timeoutID = setTimeout(() => {
            controller.abort(
              new Error(`Timeout reached: ${delay}ms (retries: ${retryCount})`)
            );
          }, delay);
          return fetch(url, { signal })
            .then(resolve)
            .catch(reject)
            .finally(() => clearTimeout(timeoutID));
        });
        timer.stop(fetchTxsTimerLabel);
        // allow unexpected status codes to cause a retry instead of exiting
        if (response?.status !== 200) {
          throw new Error(
            `RPC API returned status code: ${url} ${response?.status}`
          );
        }
      } catch (e) {
        timer.stop(fetchTxsTimerLabel);
        // remove single "last" label, it will be retried again
        timer.remove(fetchTxsTimerLabel);
        retryCount += 1;
        // delay the next request with a linear back-off;
        const delay = retryCount * 1 * seconds * inMs;
        const stopWaitTimer = timer.start('back-off:txs');
        await new Promise((resolve) => setTimeout(resolve, delay));
        stopWaitTimer();
        defaultLogger.error(
          `Could not fetch txs from URL: ${url} (status: ${
            response?.status ?? (e as Error)?.message
          })`
        );
      }
    }

    // read the RPC tx search results for tx hashes
    const stopParsingTimer = timer.start(`parsing:txs:size-${itemsToRequest}`);
    const { result } = (await response.json()) as RpcTxSearchResponse;
    stopParsingTimer();
    for (const { height, hash, tx_result } of result.txs) {
      // note current block height
      const newHeight = Number(height);
      if (newHeight > maxBlockHeight) {
        // set last known (completed) block height to the previous height
        // as we don't expect to see any further transactions from that block
        lastBlockHeight.set(maxBlockHeight);
        // set this loop to continue only after listeners of the
        // waitForNextBlock (and the 'newHeight' event) have been resolved
        await new Promise((resolve) => setTimeout(resolve, 1));
        // set new height for the next for-loop if condition
        maxBlockHeight = newHeight;
      }

      // skip this tx if the result code was 0 (there was an error)
      if (tx_result.code !== 0) {
        continue;
      }

      // fetch each block info from RPC API to fill in data from previous REST API calls
      // RPC tx_result does not have: `timestamp`, `raw_log`
      if (!blockTimestamps[height]) {
        let retryCount = 0;
        let response: Response | undefined = undefined;
        const url = `${RPC_API}/header?height=${height}`;
        do {
          const fetchHeightTimerLabel = `fetching:height:try-${retryCount
            .toFixed(0)
            .padEnd(3, '0')}:last`;
          try {
            timer.start(fetchHeightTimerLabel);
            response = await fetch(url);
            timer.stop(fetchHeightTimerLabel);
            if (response?.status !== 200) {
              throw new Error(
                `RPC API returned status code: ${url} ${response?.status}`
              );
            }
          } catch (e) {
            timer.stop(fetchHeightTimerLabel);
            // remove single "last" label, it will be retried again
            timer.remove(fetchHeightTimerLabel);
            logger.error(
              `Could not fetch block: ${url} (status: ${response?.status})`
            );
            retryCount += 1;
            // delay the next request with a linear back-off;
            const delay = retryCount * 1 * seconds * inMs;
            const stopWaitTimer = timer.start('back-off:height');
            await new Promise((resolve) => setTimeout(resolve, delay));
            stopWaitTimer();
          }
        } while (response?.status !== 200);
        const stopParsingTimer = timer.start('parsing:height');
        const { result } =
          (await response.json()) as RpcBlockHeaderLookupResponse;
        stopParsingTimer();
        blockTimestamps[height] = result.header.time;
      }
      const timestamp = blockTimestamps[height];

      const stopProcessingTimer = timer.start('processing:txs');
      // ingest single tx
      await ingestTxs(
        [translateTxResponse(tx_result, { height, timestamp, txhash: hash })],
        timer
      );
      stopProcessingTimer();
    }

    // return next page information for page iterating function
    const pageItemCount = result.txs.length;
    const totalItemCount = Number(result.total_count) || 0;
    const currentItemCount = offset + pageItemCount;
    const nextOffset =
      currentItemCount < totalItemCount ? currentItemCount : null;
    return [pageItemCount, totalItemCount, nextOffset];
  }, logger.child({ label: 'transaction' }));

  return maxBlockHeight;
}

// export a function to allow other functions to listen for the next block
const newHeightEmitter = new EventEmitter();
// keep track of last block height in a class instance with an internal var
// this is to help assure lastBlockHeight is not manipulated accidentally
// and to let us know that when we access lastBlockHeight.get() it may be
// different each time during an asynchronous function
class BlockHeight {
  private lastBlockHeight = 0;
  get() {
    return this.lastBlockHeight;
  }
  set(height: number) {
    if (height > this.lastBlockHeight) {
      this.lastBlockHeight = height;
      newHeightEmitter.emit('newHeight', height);
    }
  }
}
// last block height means "last completed/finalized block height"
// it should be safe to assume no new transactions will appear in this block
const lastBlockHeight = new BlockHeight();

// expose last block height synchronously to other files, but not the set method
export function getLastBlockHeight() {
  return lastBlockHeight.get();
}

// export a function to allow other functions to listen for the next block
export function waitForNextBlock(maxMs = 1 * minutes * inMs): Promise<number> {
  return new Promise((resolve, reject) => {
    // add timeout
    const timeout =
      maxMs > 0
        ? setTimeout(() => {
            // cancel listener
            newHeightEmitter.removeListener('newHeight', listener);
            // return error
            reject(
              new Error(`New Height listener timeout after ${maxMs / 1000}s`)
            );
          }, Math.min(Math.pow(2, 31) - 1, maxMs))
        : -1;
    // add listener
    const listener = (height: number) => {
      // remove timoue
      clearTimeout(timeout);
      // return height
      resolve(height);
    };
    newHeightEmitter.once('newHeight', listener);
  });
}

interface RpcAbciResponse {
  result: { last_block_height: string };
}
export async function keepUp() {
  defaultLogger.info(
    `keeping up: polling from block height: ${lastBlockHeight.get()}`
  );
  let lastHeartbeatTime = Date.now();

  // poll for updates
  async function poll() {
    pollingLogger.info('keeping up: polling');
    const startTime = Date.now();
    try {
      const previousLastBlockHeight = lastBlockHeight.get();
      // get last known block height before querying transactions
      // this value is only used if the transactions list from the block height
      // contains no transactions (and we can't derive the last known block height)
      const lastAbciBlockHeight =
        previousLastBlockHeight > 0
          ? await fetch(`${RPC_API}/abci_info`)
              .then((response) => response.json() as Promise<RpcAbciResponse>)
              .then(({ result }) => {
                return Number(result.last_block_height) || 0;
              })
          : 0;

      const maxTxBlockHeight = await catchUp({
        fromBlockHeight: previousLastBlockHeight + 1,
        logger: pollingLogger,
      });
      const now = Date.now();
      const duration = now - startTime;

      // all txs for the lastAbciBlockHeight have been processed so we can set
      // the new lastBlockHeight and inform all listeners of the new value
      const newBlockHeight = maxTxBlockHeight || lastAbciBlockHeight;
      lastBlockHeight.set(newBlockHeight);

      // log block height increments
      if (newBlockHeight > previousLastBlockHeight) {
        defaultLogger.info(
          `keeping up: last block processed: ${newBlockHeight}`
        );
        lastHeartbeatTime = now;
      } else {
        pollingLogger.info(
          `keeping up: no change (done in ${formatNumber(duration)}ms)`
        );
        if (now - lastHeartbeatTime > 10000) {
          defaultLogger.info('keeping up: still polling ...');
          lastHeartbeatTime = now;
        }
      }
    } catch (err) {
      // log but ignore a sync error (it might succeed next time)
      defaultLogger.info('keeping up: Unable to sync during poll');
      defaultLogger.error(err);
    }

    // poll again after a certain amount of time has passed
    // note: prefer setTimeout over setInterval because of concerns about
    // overlapping ingestions into the DB (ie. if ingestion takes longer than
    // the setInterval time then multiple invocations of catchUp will run concurrently)
    setTimeout(poll, pollIntervalMs);
  }

  poll();
}
