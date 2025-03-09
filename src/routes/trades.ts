import { Request } from '@hapi/hapi';
import sql, { raw } from 'sql-template-tag';

import { handleResponse } from '../utils/response';
import { getCachedResponse } from '../utils/cache-query';
import { hours, inMs, seconds } from '../utils/units';
import { selectDexTickUpdatesWithSwapAmountFix } from './swap-volume';

const LIMIT_ROWS = 50;
const DUST_LEVEL = 25;

export const route = {
  method: 'GET',
  path: '/trades/{denomA}/{denomB}',
  handler: handleResponse(
    async (
      request: Request<{
        Params: { denomA: string; denomB: string };
        Query: {
          from?: number;
          to?: number;
          limit?: number;
        };
      }>,
      abortSignal: AbortSignal
    ) => {
      const [denom0, denom1] = [
        request.params.denomA,
        request.params.denomB,
      ].sort();

      // default to bounds far in the future and in the past
      const unixFrom = Number(request.query.from) || 0;
      const unixTo = Number(request.query.to) || 0;

      const sourceTableHeight = await getCachedResponse<{ height: string }>(
        sql`
          SELECT max("height") AS "height"
          FROM spacebox."raw_block_results"
        `,
        abortSignal
      );

      // get timeseries query
      const currentHeight =
        unixTo === 0 || unixTo * 1000 >= Date.now()
          ? // for a "now-bound" request use the slightly-cached relevant data height
            await getCachedResponse<{ height: string }>(
              sql`
                SELECT max("height") AS "height"
                FROM spacebox."dex_message_event_tick_update"
                WHERE "TokenZero" = ${denom0}
                  AND "TokenOne" = ${denom1}
                  AND "is_swap" = 1
              `,
              abortSignal,
              {
                cacheTime: 10 * seconds * inMs,
                cacheVersion:
                  Number(sourceTableHeight.data.at(0)?.height) ?? undefined,
              }
            )
          : undefined;

      return await getCachedResponse<
        {
          time: string;
          height: string;
          tx?: string;
          buy_last: boolean;
          buy: string;
          sell: string;
        },
        {
          time: string;
          height: string;
          tx?: string;
          buy?: string;
          sell?: string;
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
          WHERE "buy" > ${DUST_LEVEL}
            OR "sell" > ${DUST_LEVEL}
          LIMIT ${request.query.limit ?? LIMIT_ROWS}
        `,
        abortSignal,
        {
          heartbeat: Number(sourceTableHeight.data.at(0)?.height),
          getHeight: (data) => Number(data.at(0)?.height),
          // transform buy+sell rows (a tx or BeginBlock may have both)
          // into separate buy and sell rows
          getRow: ({ tx, buy_last, buy, sell, ...row }) => {
            const isBuy = !!Number(buy);
            const isSell = !!Number(sell);
            // put buy first if buy_last (list is in reverse-chronologial order)
            if (isBuy && isSell) {
              return buy_last
                ? [
                    { ...row, buy, tx: tx || undefined },
                    { ...row, sell, tx: tx || undefined },
                  ]
                : [
                    { ...row, sell, tx: tx || undefined },
                    { ...row, buy, tx: tx || undefined },
                  ];
            }
            // else just put any direction that is found
            else if (isBuy) {
              return { ...row, buy, tx: tx || undefined };
            } else if (isSell) {
              return { ...row, sell, tx: tx || undefined };
            } else {
              return [];
            }
          },
          getMetadata: (metadata) => {
            return (
              metadata
                // remove unneeded column definitions
                ?.filter((row) =>
                  ['time', 'height', 'tx', 'buy', 'sell'].includes(row.name)
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
          cacheTime: 1 * hours * inMs,
          cacheVersion: Number(currentHeight?.data.at(0)?.height) || 0,
        }
      );
    }
  ),
};
