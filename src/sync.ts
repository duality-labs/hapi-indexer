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
  COLOR_LOGS = '',
} = process.env;

const pollIntervalMs = Number(POLLING_INTERVAL_MS) || 500;

class Timer {
  state: { [label: string]: { startTime: number; elapsedTime: number } } = {};
  get(label: string): number | undefined {
    return this.state[label]?.elapsedTime;
  }
  start(...labels: string[] | string[][]) {
    labels
      .flatMap((v) => v)
      .forEach((label) => {
        // initialize new labels if needed
        this.state[label] = this.state[label] || {
          startTime: 0,
          elapsedTime: 0,
        };
        // set starting time
        this.state[label].startTime = Date.now();
      });
    // return handy stop callback
    return () => this.stop(...labels);
  }
  stop(...labels: string[] | string[][]) {
    labels
      .flatMap((v) => v)
      .forEach((label) => {
        // increment elapsed time
        this.state[label].elapsedTime +=
          Date.now() - this.state[label].startTime;
      });
  }
  reset(...labels: string[] | string[][]) {
    labels
      .flatMap((v) => v)
      .forEach((label) => {
        this.state[label] = { startTime: 0, elapsedTime: 0 };
      });
  }
}
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
          const maxKeyLength = Math.max(
            ...Object.keys(timer.state).map((key) => key.length)
          );
          defaultLogger.info(
            `timing:\n${Object.entries(timer.state)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([label, { elapsedTime }]) => {
                return `${label.padEnd(maxKeyLength)} : ${elapsedTime}ms`;
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
      // reset timers that just note the last time of each type of request
      timer.reset([
        'fetching:txs:last',
        `fetching:txs:last:size-${itemsToRequest}`,
      ]);
      const stopFetchTimer = timer.start([
        'fetching',
        'fetching:txs',
        'fetching:txs:last',
        `fetching:txs:try-${retryCount}`,
        `fetching:txs:size-${itemsToRequest}`,
        `fetching:txs:last:size-${itemsToRequest}`,
      ]);
      try {
        response = await fetch(url);
        stopFetchTimer();
        // allow unexpected status codes to cause a retry instead of exiting
        if (response?.status !== 200) {
          throw new Error(
            `RPC API returned status code: ${url} ${response?.status}`
          );
        }
      } catch (e) {
        stopFetchTimer();
        retryCount += 1;
        // delay the next request with a linear back-off;
        const delay = retryCount * 1 * seconds * inMs;
        const stopWaitTimer = timer.start(['back-off', 'back-off:txs']);
        await new Promise((resolve) => setTimeout(resolve, delay));
        stopWaitTimer();
        logger.error(
          `Could not fetch txs from URL: ${url} (status: ${response?.status})`
        );
      }
    }

    // read the RPC tx search results for tx hashes
    const stopParsingTimer = timer.start([
      'parsing',
      'parsing:txs',
      `parsing:txs:size-${itemsToRequest}`,
    ]);
    const { result } = (await response.json()) as RpcTxSearchResponse;
    stopParsingTimer();
    for (const { height, hash, tx_result } of result.txs) {
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
          const stopFetchTimer = timer.start([
            'fetching',
            'fetching:height',
            `fetching:height:try-${retryCount}`,
          ]);
          try {
            response = await fetch(url);
            stopFetchTimer();
            if (response?.status !== 200) {
              throw new Error(
                `RPC API returned status code: ${url} ${response?.status}`
              );
            }
          } catch (e) {
            stopFetchTimer();
            logger.error(
              `Could not fetch block: ${url} (status: ${response?.status})`
            );
            retryCount += 1;
            // delay the next request with a linear back-off;
            const delay = retryCount * 1 * seconds * inMs;
            const stopWaitTimer = timer.start(['back-off', 'back-off:height']);
            await new Promise((resolve) => setTimeout(resolve, delay));
            stopWaitTimer();
          }
        } while (response?.status !== 200);
        const stopParsingTimer = timer.start(['parsing', 'parsing:height']);
        const { result } =
          (await response.json()) as RpcBlockHeaderLookupResponse;
        stopParsingTimer();
        blockTimestamps[height] = result.header.time;
      }
      const timestamp = blockTimestamps[height];

      const stopProcessingTimer = timer.start(['processing', 'processing:txs']);
      // ingest single tx
      await ingestTxs([
        translateTxResponse(tx_result, { height, timestamp, txhash: hash }),
      ]);
      stopProcessingTimer();

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
  let lastHeartbeatTime = Date.now();

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
      const now = Date.now();
      const duration = now - startTime;

      // log block height increments
      if (maxBlockHeight > lastBlockHeight) {
        newHeightEmitter.emit('newHeight', maxBlockHeight);
        defaultLogger.info(
          `keeping up: last block processed: ${maxBlockHeight}`
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
