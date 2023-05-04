import { TxResponse } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';
import { createLogger, transports, config, format, Logger } from 'winston';
import { logFileTransport } from './logger';

import ingestRestTxs from './storage/sqlite3/ingest/rest/tx';

interface PlainTxResponse extends Omit<TxResponse, 'rawLog'> {
  raw_log: TxResponse['rawLog'];
  gas_wanted: TxResponse['gasWanted'];
  gas_used: TxResponse['gasUsed'];
}

interface V1Beta1GetTxsEventResponse {
  /** txs is the list of queried transactions. */
  txs?: unknown[];

  /** tx_responses is the list of queried TxResponses. */
  tx_responses?: PlainTxResponse[];

  /** pagination defines an pagination for the response. */
  pagination?: {
    next_key: string;
    total: string;
  };
}
const { REST_API = '', POLLING_INTERVAL_SECONDS = '' } = process.env;

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

let maxBlockHeight = 0;

async function catchUpREST({
  fromBlockHeight = 0,
  logger = defaultLogger,
} = {}) {
  // read tx pages
  await iterateThroughPages(async ({ page: offset = 0 }) => {
    // we default starting page to 1 as this API has 1-based page numbers
    // max API response page item count is 100
    const itemsPerPage = 100;
    const response = await fetch(
      `
      ${REST_API}/cosmos/tx/v1beta1/txs
        ?events=tx.height>=${fromBlockHeight}
        ${offset ? `&pagination.offset=${offset}` : ''}
        &pagination.limit=${itemsPerPage}
        &pagination.count_total=true
        &order_by=ORDER_BY_ASC
    `.replace(/\s+/g, '')
    ); // remove spaces from URL
    const {
      pagination,
      txs = [],
      tx_responses: pageItems = [],
    } = await (response.json() as Promise<V1Beta1GetTxsEventResponse>).then(
      ({ pagination, txs, tx_responses }: V1Beta1GetTxsEventResponse) => ({
        pagination,
        txs,
        tx_responses: tx_responses?.map(
          ({ raw_log, gas_wanted, gas_used, ...response }: PlainTxResponse) => {
            const txResponse: TxResponse = {
              ...response,
              rawLog: raw_log,
              gasWanted: gas_wanted,
              gasUsed: gas_used,
            };
            return txResponse;
          }
        ),
      })
    );

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
    const nextOffset =
      currentItemCount < totalItemCount ? currentItemCount : null;
    return [pageItemCount, totalItemCount, nextOffset];
  }, logger.child({ label: 'transaction' }));
}

export async function keepUpREST() {
  defaultLogger.info(
    `keeping up: polling from block height: ${maxBlockHeight}`
  );

  // poll for updates
  async function poll() {
    defaultLogger.info('keeping up: the polling');
    const lastBlockHeight = maxBlockHeight;
    const startTime = Date.now();
    await catchUpREST({
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

    // poll again after a certain amount of time has passed
    // note: prefer setTimeout over setInterval because of concerns about
    // overlapping ingestions into the DB (ie. if ingestion takes longer than
    // the setInterval time then multiple invocations of catchUp will run concurrently)
    setTimeout(poll, 1000 * pollIntervalTimeSeconds);
  }

  poll();
}

// choose method to use to catch up to the chain with
export { catchUpREST as catchUp };
export { keepUpREST as keepUp };
