import EventEmitter from 'events';
import { createLogger, transports, config, format, Logger } from 'winston';
import { Response } from 'undici';
import { ResponseDeliverTx } from 'cosmjs-types/tendermint/abci/types';

import { logFileTransport } from './logger';
import { TxResponse } from './@types/tx';

import ingestTxs from './storage/sqlite3/ingest/ingestTxResponse';
import { inMs, minutes, seconds } from './storage/sqlite3/db/timeseriesUtils';

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
} = process.env;

const pollIntervalMs = Number(POLLING_INTERVAL_MS) || 500;

class Timer {
  value = 0;
  startTime = 0;
  start() {
    this.startTime = Date.now();
  }
  stop() {
    return (this.value += Date.now() - this.startTime);
  }
  reset() {
    this.value = 0;
    this.startTime = 0;
  }
}
interface SyncTimers {
  fetching: Timer;
  parsing: Timer;
  processing: Timer;
}
type PageReader = (options: {
  page?: number;
  timers: SyncTimers;
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
    format.colorize(),
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
    timers?: SyncTimers
  ) {
    const now = Date.now();
    const elapsedTime = now - lastProgressTime;
    if (message || timers || elapsedTime > 1000) {
      // send import timing logs to console as well as file
      (timers?.processing.value ? defaultLogger : logger).info(
        message ||
          `import progress: ${formatNumber(
            (100 * numerator) / divisor,
            1,
            5
          )}% (${formatNumber(numerator)} items) ${
            timers
              ? `(fetching: ${formatNumber(
                  timers.fetching.value,
                  0,
                  6
                )}ms, parsing: ${formatNumber(
                  timers.parsing.value,
                  0,
                  3
                )}ms, processing: ${formatNumber(
                  timers.processing.value / (numerator - lastNumerator),
                  0,
                  3
                )}ms per item)`
              : `(${formatNumber(elapsedTime, 0, 6)}ms)`
          }`
      );
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
    const timers: SyncTimers = {
      fetching: new Timer(),
      parsing: new Timer(),
      processing: new Timer(),
    };
    // read page data and return counting details
    const [pageItemCount, totalItemCount, nextPage] = await readPage({
      page: currentPage,
      timers,
    });

    // update progress
    previousItemCount = currentItemCount;
    currentItemCount += pageItemCount;
    currentPage = nextPage;

    // see progress
    printProgress(currentItemCount, totalItemCount, '', timers);
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

let maxBlockHeight = 0;
const blockTimestamps: { [height: string]: string } = {};
// restrict items per page to between 1-100, and default to 100
// note: this number should be 1 or divisible by 10
const itemsPerPage = Math.max(1, Math.min(100, Number(SYNC_PAGE_SIZE) || 100));

export async function catchUp({
  fromBlockHeight = 0,
  logger = defaultLogger,
} = {}) {
  // read tx pages
  await iterateThroughPages(async ({ page: offset = 0, timers }) => {
    // we default starting page to 1 as this API has 1-based page numbers
    // max API response page item count is 100
    let response: Response | undefined = undefined;
    let retryCount = 0;
    while (!response) {
      // back-off items to request exponentially
      // (it is possible that some chunks of transactions are very large)
      // itemsToRequest follows back-off of: 100, 10, 1, 1, 1, ..., 0
      let itemsToRequest = Math.ceil(itemsPerPage / Math.pow(10, retryCount));
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
      try {
        timers.fetching.start();
        response = await fetch(url);
        timers.fetching.stop();
        // allow unexpected status codes to cause a retry instead of exiting
        if (response.status !== 200) {
          throw new Error(
            `RPC API returned status code: ${response.url} ${response.status}`
          );
        }
      } catch (e) {
        retryCount += 1;
        // delay the next request with a linear back-off;
        const delay = retryCount * 1 * seconds * inMs;
        await new Promise((resolve) => setTimeout(resolve, delay));
        logger.error(
          `Could not fetch txs from URL: ${url} (status: ${response?.status})`
        );
      }
    }

    // read the RPC tx search results for tx hashes
    timers.parsing.start();
    const { result } = (await response.json()) as RpcTxSearchResponse;
    timers.parsing.stop();
    for (const { height, hash, tx_result } of result.txs) {
      // skip this tx if the result code was 0 (there was an error)
      if (tx_result.code !== 0) {
        continue;
      }

      // fetch each block info from RPC API to fill in data from previous REST API calls
      // RPC tx_result does not have: `timestamp`, `raw_log`
      if (!blockTimestamps[height]) {
        timers.fetching.start();
        const response = await fetch(`${RPC_API}/header?height=${height}`);
        timers.fetching.stop();
        if (response.status !== 200) {
          throw new Error(
            `RPC API returned status code: ${RPC_API} ${response.status}`
          );
        }
        timers.parsing.start();
        const { result } =
          (await response.json()) as RpcBlockHeaderLookupResponse;
        timers.parsing.stop();
        blockTimestamps[height] = result.header.time;
      }
      const timestamp = blockTimestamps[height];

      timers.processing.start();
      // ingest single tx
      await ingestTxs([
        translateTxResponse(tx_result, { height, timestamp, txhash: hash }),
      ]);
      timers.processing.stop();

      // note current block height
      maxBlockHeight = Number(height);
    }

    // return next page information for page iterating function
    const pageItemCount = result.txs.length;
    const totalItemCount = Number(result.total_count) || 0;
    const currentItemCount = offset + pageItemCount;
    const nextOffset =
      currentItemCount < totalItemCount ? currentItemCount : null;
    return [pageItemCount, totalItemCount, nextOffset];
  }, logger.child({ label: 'transaction' }));
}

// export a function to allow other functions to listen for the next block
const newHeightEmitter = new EventEmitter();
export function waitForNextBlock(maxMs = 1 * minutes * inMs): Promise<number> {
  return new Promise((resolve, reject) => {
    // add timeout
    const timeout = setTimeout(() => {
      // cancel listener
      newHeightEmitter.removeListener('newHeight', listener);
      // return error
      reject(new Error(`New Height listener timeout after ${maxMs / 1000}s`));
    }, maxMs);
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

export async function keepUp() {
  defaultLogger.info(
    `keeping up: polling from block height: ${maxBlockHeight}`
  );

  // poll for updates
  async function poll() {
    pollingLogger.info('keeping up: polling');
    const lastBlockHeight = maxBlockHeight;
    const startTime = Date.now();
    try {
      await catchUp({
        fromBlockHeight: maxBlockHeight + 1,
        logger: pollingLogger,
      });
      const duration = Date.now() - startTime;

      // log block height increments
      if (maxBlockHeight > lastBlockHeight) {
        newHeightEmitter.emit('newHeight', maxBlockHeight);
        defaultLogger.info(
          `keeping up: last block processed: ${maxBlockHeight}`
        );
      } else {
        pollingLogger.info(
          `keeping up: no change (done in ${formatNumber(duration)}ms)`
        );
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
