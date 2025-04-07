import sql, { raw } from 'sql-template-tag';

import { Route } from '../types';
import { getCachedResponse } from '../utils/cache-query';
import { hours, inMs, toUnixTime } from '../utils/units';
import { selectDexTickUpdatesWithSwapAmountFix } from './swap-volume';

const LIMIT_ROWS = 50;
const DEFAULT_DUST_LEVEL_AMOUNT = 100;

interface Request {
  params: { denomA: string; denomB: string };
  query: {
    from?: string;
    to?: string;
    limit?: string;
    show_trades_above_amount?: string;
  };
}
interface Response {
  time: string;
}

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/trades/:denomA/:denomB',
  handler: async (request, abortSignal, previousResponse) => {
    const [denom0, denom1] = [
      request.params.denomA,
      request.params.denomB,
    ].sort();

    // restrict order of magnitude filters (to not have too many cache versions)
    const requestAmountFilter = Math.max(
      0,
      Math.min(
        10e18,
        Number(
          request.query.show_trades_above_amount ?? DEFAULT_DUST_LEVEL_AMOUNT
        )
      )
    );
    const amountFilter = requestAmountFilter > 0 ? requestAmountFilter : 0;

    // default to bounds far in the future and in the past
    const timePrevious = toUnixTime(previousResponse?.data.at(0)?.time);
    // ClickHouse will compare either native strings or Unix timestamps
    const unixFrom = timePrevious || Number(request.query.from) || 0;
    const unixTo = Number(request.query.to) || 0;

    const sourceTableHeight = await getCachedResponse<{ height: string }>(
      sql`
          SELECT max("height") AS "height"
          FROM spacebox."raw_block_results"
        `,
      abortSignal
    );

    // get timeseries data height (quick query to determine cache version)
    const currentHeight = await getCachedResponse<{
      height: string;
      time: string;
    }>(
      sql`
          SELECT
            max("height") AS "height",
            argMax("timestamp", t."height") as "time"
          FROM spacebox."dex_message_event_tick_update" as t
          WHERE "is_swap" = 1
            AND "TokenZero" = ${denom0}
            AND "TokenOne" = ${denom1}
        `,
      abortSignal
    );

    // get timeseries data
    return await getCachedResponse<
      {
        time: string;
        height: string;
        tx?: string;
        buy_last: boolean;
        buy: string;
        sell: string;
        buy_at: string;
        sell_at: string;
      },
      {
        time: string;
        height: string;
        tx?: string;
        buy?: string;
        sell?: string;
        buy_at?: string;
        sell_at?: string;
      }
    >(
      sql`
          WITH recent_trades as (
            SELECT
              "timestamp" as "time",
              "height",
              block_txhash.txhash as "tx",
              -- the data at rest should be in ascending event_index order
              -- find the last trade direction by selecting last_value
              last_value("TokenIn") = ${request.params.denomA} as "buy_last",
              avgWeightedIf("TickIndex", "SwapAmountOut", "TokenIn" = ${
                request.params.denomA
              }) as "buy_at",
              avgWeightedIf("TickIndex", "SwapAmountIn", "TokenIn" != ${
                request.params.denomA
              }) as "sell_at",
              sumIf("SwapAmountOut", "TokenIn" = ${
                request.params.denomA
              }) as "buy",
              sumIf("SwapAmountIn", "TokenIn" != ${
                request.params.denomA
              }) as "sell"
            FROM (${selectDexTickUpdatesWithSwapAmountFix}) as tick_updates
            LEFT JOIN spacebox.raw_block_txhash as block_txhash
              ON tick_updates."block_part_index" = 2
              AND block_txhash."height" = tick_updates."height"
              AND block_txhash."tx_index" = tick_updates."tx_index"
            WHERE "is_swap" = 1
              AND "TokenZero" = ${denom0}
              AND "TokenOne" = ${denom1}
              -- add optional timestamp filters only if defined
              ${unixFrom ? sql`AND "timestamp" >= ${unixFrom}` : raw('')}
              ${unixTo ? sql`AND "timestamp" < ${unixTo}` : raw('')}
            GROUP BY "height", "block_part_index", "tx_index", "tx", "time"
            ORDER BY
              "height" DESC,
              "block_part_index" DESC,
              "tx_index" DESC
          )
          -- from aggregated trade list, remove tiny row amounts
          SELECT * FROM recent_trades
          WHERE ("buy" + "sell") >= ${amountFilter}
          LIMIT ${request.query.limit ?? LIMIT_ROWS}
        `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        getHeight: (data) => Number(data.at(0)?.height),
        // transform buy+sell rows (a tx or BeginBlock may have both)
        // into separate buy and sell rows
        getRow: ({ tx, buy_last, buy, sell, buy_at, sell_at, ...row }) => {
          const isBuy = !!Number(buy);
          const isSell = !!Number(sell);
          // put buy first if buy_last (list is in reverse-chronologial order)
          if (isBuy && isSell) {
            return buy_last
              ? [
                  { ...row, buy, buy_at, tx: tx || undefined },
                  { ...row, sell, sell_at, tx: tx || undefined },
                ]
              : [
                  { ...row, sell, sell_at, tx: tx || undefined },
                  { ...row, buy, buy_at, tx: tx || undefined },
                ];
          }
          // else just put any direction that is found
          else if (isBuy) {
            return { ...row, buy, buy_at, tx: tx || undefined };
          } else if (isSell) {
            return { ...row, sell, sell_at, tx: tx || undefined };
          } else {
            return [];
          }
        },
        getMetadata: (metadata) => {
          return (
            metadata
              // remove unneeded column definitions
              ?.filter((row) =>
                [
                  'time',
                  'height',
                  'tx',
                  'buy',
                  'sell',
                  'buy_at',
                  'sell_at',
                ].includes(row.name)
              )
              // add volume units
              ?.map((row) =>
                ['buy', 'sell'].includes(row.name)
                  ? { ...row, units: request.params.denomA }
                  : row
              )
              // add time units
              ?.map((row) =>
                row.name === 'time'
                  ? { ...row, units: 'YYYY-MM-DD hh:mm:ss UTC' }
                  : row
              )
          );
        },
        // flag as complete if there will be no data changes after this
        isComplete:
          !!unixTo && toUnixTime(currentHeight.data.at(0)?.time) > unixTo,
        cacheTime: 1 * hours * inMs,
        cacheVersion: Number(currentHeight?.data.at(0)?.height) || 0,
      }
    );
  },
};
