import EventEmitter from 'events';
import { createLogger, transports, config, format, Logger } from 'winston';
import { ResponseDeliverTx } from 'cosmjs-types/tendermint/abci/types';

import { logFileTransport } from './logger';
import { TxResponse } from './@types/tx';

import ingestTxs from './storage/sqlite3/ingest/ingestTxResponse';

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

const { RPC_API = '', POLLING_INTERVAL_MS = '' } = process.env;

const pollIntervalMs = Number(POLLING_INTERVAL_MS) || 500;

type PageReader = (options: {
  page?: number;
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

async function iterateThroughPages(readPage: PageReader, logger: Logger) {
  let lastProgressTime = 0;
  let lastNumerator = 0;
  function printProgress(numerator: number, divisor: number, message?: string) {
    const now = Date.now();
    if (message || now - lastProgressTime > 1000) {
      logger.info(
        message ||
          `import progress: ${((100 * numerator) / divisor)
            .toFixed(1)
            .padStart(5, ' ')}% (${numerator} items) (~${(
            (now - lastProgressTime) /
            (numerator - lastNumerator)
          ).toFixed(0)}ms per item)`
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
    // read page data and return counting details
    const [pageItemCount, totalItemCount, nextPage] = await readPage({
      page: currentPage,
    });

    // update progress
    previousItemCount = currentItemCount;
    currentItemCount += pageItemCount;
    currentPage = nextPage;

    // see progress
    printProgress(currentItemCount, totalItemCount);
  } while (currentItemCount > previousItemCount && !!currentPage);
  const duration = Date.now() - startTime;
  printProgress(
    1,
    1,
    `import done (done in ${(duration / 1000).toFixed(1)} seconds, ${(
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

export async function catchUp({
  fromBlockHeight = 0,
  logger = defaultLogger,
} = {}) {
  // read tx pages
  await iterateThroughPages(async ({ page: offset = 0 }) => {
    // we default starting page to 1 as this API has 1-based page numbers
    // max API response page item count is 100
    const itemsPerPage = 100;
    const response = await fetch(
      `${RPC_API}/tx_search?query="${encodeURIComponent(
        `tx.height>=${fromBlockHeight} AND message.module='dex'`
      )}"&per_page=${itemsPerPage}&page=${
        Math.round(offset / itemsPerPage) + 1
      }`
    );

    if (response.status !== 200) {
      throw new Error(
        `RPC API returned status code: ${RPC_API} ${response.status}`
      );
    }

    // read the RPC tx search results for tx hashes
    const { result } = (await response.json()) as RpcTxSearchResponse;
    for (const { height, hash, tx_result } of result.txs) {
      // skip this tx if the result code was 0 (there was an error)
      if (tx_result.code !== 0) {
        continue;
      }

      // fetch each block info from RPC API to fill in data from previous REST API calls
      // RPC tx_result does not have: `timestamp`, `raw_log`
      if (!blockTimestamps[height]) {
        const response = await fetch(`${RPC_API}/header?height=${height}`);
        if (response.status !== 200) {
          throw new Error(
            `RPC API returned status code: ${RPC_API} ${response.status}`
          );
        }
        const { result } =
          (await response.json()) as RpcBlockHeaderLookupResponse;
        blockTimestamps[height] = result.header.time;
      }
      const timestamp = blockTimestamps[height];

      // ingest single tx
      await ingestTxs([
        translateTxResponse(tx_result, { height, timestamp, txhash: hash }),
      ]);

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

export const newHeightEmitter = new EventEmitter();

export async function keepUp() {
  defaultLogger.info(
    `keeping up: polling from block height: ${maxBlockHeight}`
  );

  // poll for updates
  async function poll() {
    defaultLogger.info('keeping up: polling');
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
          `keeping up: last block processed: ${maxBlockHeight} (done in ${(
            duration / 1000
          ).toFixed(3)} seconds)`
        );
      } else {
        defaultLogger.info(
          `keeping up: no change (done in ${(duration / 1000).toFixed(
            3
          )} seconds)`
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
