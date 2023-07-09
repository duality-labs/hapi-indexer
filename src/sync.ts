import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';
import { createLogger, transports, config, format, Logger } from 'winston';
import { logFileTransport } from './logger';

import ingestTxs from './storage/sqlite3/ingest/ingestTxResponse';

interface PlainTxResponse extends Omit<TxResponse, 'rawLog'> {
  raw_log: TxResponse['rawLog'];
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
      tx_result: {
        code: number;
      };
    }>;
  };
}
interface RestTxHashLookupResponse {
  tx: object;
  tx_response: PlainTxResponse;
}

const {
  REST_API = '',
  RPC_API = '',
  POLLING_INTERVAL_SECONDS = '',
} = process.env;

const pollIntervalTimeSeconds = Number(POLLING_INTERVAL_SECONDS) || 5;

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

function translateTxResponse({
  raw_log,
  gas_wanted,
  gas_used,
  ...response
}: PlainTxResponse): TxResponse {
  return {
    ...response,
    rawLog: raw_log,
    gasWanted: gas_wanted,
    gasUsed: gas_used,
  };
}

let maxBlockHeight = 0;

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

      // fetch each tx from REST API (which has more information)
      // RPC tx_result does not have: `timestamp`, `raw_log`
      const response = await fetch(`${REST_API}/cosmos/tx/v1beta1/txs/${hash}`);
      if (response.status !== 200) {
        throw new Error(
          `REST API returned status code: ${REST_API} ${response.status}`
        );
      }

      const { tx_response } =
        (await response.json()) as RestTxHashLookupResponse;
      // ingest single tx
      await ingestTxs([translateTxResponse(tx_response)]);

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
    setTimeout(poll, 1000 * pollIntervalTimeSeconds);
  }

  poll();
}
