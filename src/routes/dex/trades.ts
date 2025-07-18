import sql, { raw } from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import { hours, inMs, toUnixTime } from '../../utils/units';

const DEFAULT_LIMIT_ROWS = 50;
const MAX_LIMIT_ROWS = 1000;
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
  height: string;
  tx?: string;
  buy?: string;
  sell?: string;
  buy_at?: string;
  sell_at?: string;
}

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/dex/trades/:denomA/:denomB',
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
          FROM spacebox.dex_swaps as t
          WHERE "action" = 'TickUpdate'
            AND "TokenZero" = ${denom0}
            AND "TokenOne" = ${denom1}
        `,
      abortSignal
    );

    // get timeseries data
    return await getCachedResponse<Response & { buy_last: boolean }, Response>(
      sql`
          WITH recent_trades as (
            WITH
              tick_updates as (
                SELECT
                  "timestamp",
                  "height",
                  "block_part_index",
                  "tx_index",
                  "event_index",
                  "TokenZero",
                  "TokenOne",
                  "TickIndex",
                  "ReservesInZero",
                  "ReservesInOne",
                  "ReservesOutZero",
                  "ReservesOutOne"
                FROM spacebox.dex_swaps
                WHERE "action" = 'TickUpdate'
                  AND "TokenZero" = ${denom0}
                  AND "TokenOne" = ${denom1}
                  -- add optional timestamp filters only if defined
                  ${unixFrom ? sql`AND "timestamp" >= ${unixFrom}` : raw('')}
                  ${unixTo ? sql`AND "timestamp" < ${unixTo}` : raw('')}
              ),
              deduplicated_tick_updates as (
                SELECT
                  any("timestamp") as "timestamp",
                  "height",
                  "block_part_index",
                  "tx_index",
                  "event_index",
                  any("TokenZero") as "TokenZero",
                  any("TokenOne") as "TokenOne",
                  any("TickIndex") as "TickIndex",
                  any("ReservesInZero") as "ReservesInZero",
                  any("ReservesInOne") as "ReservesInOne",
                  any("ReservesOutZero") as "ReservesOutZero",
                  any("ReservesOutOne") as "ReservesOutOne"
                FROM tick_updates
                GROUP BY "height", "block_part_index", "tx_index", "event_index"
              )
            SELECT
              "timestamp" as "time",
              "height",
              block_txhash."txhash" as "tx",
              -- the data at rest should be in ascending event_index order
              -- find the last trade direction by selecting last_value
              last_value(if("TokenZero" = ${
                request.params.denomA
              }, "ReservesInZero", "ReservesInOne")) > 0 as "buy_last",
              avgWeightedIf(
                if("TokenZero" = ${
                  request.params.denomA
                }, -"TickIndex", "TickIndex"),
                if("TokenZero" = ${
                  request.params.denomA
                }, "ReservesOutZero", "ReservesOutOne"),
                if("TokenZero" = ${
                  request.params.denomA
                }, "ReservesOutZero", "ReservesOutOne") > 0
              ) as "buy_at",
              avgWeightedIf(
                if("TokenZero" = ${
                  request.params.denomA
                }, "TickIndex", -"TickIndex"),
                if("TokenZero" = ${
                  request.params.denomA
                }, "ReservesInZero", "ReservesInOne"),
                if("TokenZero" = ${
                  request.params.denomA
                }, "ReservesInZero", "ReservesInOne") > 0
              ) as "sell_at",
              sum(
                if(
                  "TokenZero" = ${request.params.denomA},
                  "ReservesOutZero",
                  "ReservesOutOne"
                )
              ) as "buy",
              sum(
                if(
                  "TokenZero" = ${request.params.denomA},
                  "ReservesInZero",
                  "ReservesInOne"
                )
              ) as "sell"
            FROM deduplicated_tick_updates as tick_updates
            ANY LEFT JOIN spacebox.raw_block_txhash as block_txhash
              ON tick_updates."block_part_index" = 2
              AND block_txhash."height" = tick_updates."height"
              AND block_txhash."tx_index" = tick_updates."tx_index"
            GROUP BY "height", "block_part_index", "tx_index", "tx", "time"
            ORDER BY
              "height" DESC,
              "block_part_index" DESC,
              "tx_index" DESC
          )
          -- from aggregated trade list, remove tiny row amounts
          SELECT * FROM recent_trades
          WHERE ("buy" + "sell") >= ${amountFilter}
          LIMIT ${Math.max(
            1,
            Math.min(
              MAX_LIMIT_ROWS,
              Number(request.query.limit) || DEFAULT_LIMIT_ROWS
            )
          )}
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
