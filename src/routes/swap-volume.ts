import sql, { raw } from 'sql-template-tag';

import { Route } from '../types';
import { getCachedResponse } from '../utils/cache-query';
import { config } from '../config';
import {
  getTimePeriod,
  hours,
  inMs,
  seconds,
  TimePeriod,
  toUnixTime,
} from '../utils/units';

const LIMIT_ROWS = 1000;

interface Request {
  params: { denomA: string; denomB: string };
  query: {
    from?: string;
    to?: string;
    period?: TimePeriod;
  };
}
interface Response {
  time: string;
}

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/swap-volume/:denomA/:denomB',
  handler: async (request, abortSignal, previousResponse) => {
    const [denom0, denom1] = [
      request.params.denomA,
      request.params.denomB,
    ].sort();
    const denomReporting =
      config.denomsUSDC.find((denom) => {
        return [denom0, denom1].includes(denom);
      }) || request.params.denomA;

    // default to bounds far in the future and in the past
    const timePrevious = toUnixTime(previousResponse?.data.at(0)?.time);
    // ClickHouse will compare either native strings or Unix timestamps
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
    const timePeriod = getTimePeriod(request.query.period);
    if (timePeriod) {
      // get timeseries data height (quick query to determine cache version)
      const currentHeight = await getCachedResponse<{
        height: string;
        time: string;
      }>(
        sql`
            SELECT
              max(t."height") AS "height",
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
        { time: string; volume: string; height: string },
        { time: string; volume: string }
      >(
        sql`
            SELECT
              max(height) as "height",
              toStartOfInterval("timestamp", INTERVAL 1 ${raw(
                timePeriod
              )}) AS "time",
              sumIf("SwapAmountIn", "TokenIn" != ${denomReporting}) +
              sumIf("SwapAmountOut", "TokenIn" = ${denomReporting}) as "volume"
            FROM (${selectDexTickUpdatesWithSwapAmountFix})
            WHERE "is_swap" = 1
              AND "TokenZero" = ${denom0}
              AND "TokenOne" = ${denom1}
              -- add optional timestamp filters only if defined
              ${
                unixFrom || timePrevious
                  ? sql`AND "timestamp" >= ${unixFrom || timePrevious}`
                  : raw('')
              }
              ${unixTo ? sql`AND "timestamp" < ${unixTo}` : raw('')}
            GROUP BY "time"
            ORDER BY "time" DESC
            LIMIT ${LIMIT_ROWS}
          `,
        abortSignal,
        {
          heartbeat: Number(sourceTableHeight.data.at(0)?.height),
          getRow: ({ time, volume }) => ({ time, volume }),
          getHeight: (data) => Number(data.at(0)?.height),
          getMetadata: (metadata) => {
            return (
              metadata
                // remove height field
                ?.filter(({ name }) => ['time', 'volume'].includes(name))
                // add volume units
                ?.map((row) =>
                  row.name === 'volume'
                    ? { ...row, units: denomReporting }
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
    }

    const currentTime = await getCachedResponse<{
      _cache_version?: string;
      _cache_ms?: string;
    }>(
      sql`
          SELECT
            toUnixTimestamp64Milli(
              toDateTime64(
                toStartOfInterval(NOW(), INTERVAL 1 MINUTE),
                0
              )
            ) AS "_cache_version",
            100000 AS "_cache_ms"
        `,
      abortSignal,
      {
        cacheTime: 60 * seconds * inMs,
        cacheVersion: Number(sourceTableHeight.data.at(0)?.height),
      }
    );

    // get 24 hour volume cached to "beginning of the hour" version
    return await getCachedResponse<
      { time: string; volume: string; height: string },
      { time: string; volume: string }
    >(
      sql`
        SELECT
          max(height) as "height",
          toStartOfMinute(NOW()) as "time",
          sumIf("SwapAmountIn", "TokenIn" != ${denomReporting}) +
          sumIf("SwapAmountOut", "TokenIn" = ${denomReporting}) as "volume"
        FROM (${selectDexTickUpdatesWithSwapAmountFix})
        WHERE "is_swap" = 1
          AND "timestamp" >= ${
            unixFrom || sql`toStartOfMinute(addDays(NOW(), -1))`
          }
          AND "timestamp" < ${unixTo || sql`toStartOfMinute(NOW())`}
          AND "TokenZero" = ${denom0}
          AND "TokenOne" = ${denom1}
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        getRow: ({ time, volume }) => ({ time, volume }),
        getHeight: (data) => Number(data.at(0)?.height),
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => ['time', 'volume'].includes(name))
              // add volume units
              ?.map((row) =>
                row.name === 'volume' ? { ...row, units: denomReporting } : row
              )
              // add time units
              ?.map((row) =>
                row.name === 'time'
                  ? { ...row, units: 'YYYY-MM-DD hh:mm:ss UTC' }
                  : row
              )
          );
        },
        cacheTime: Number(currentTime.data.at(0)?._cache_ms) ?? undefined,
        cacheVersion:
          Number(currentTime.data.at(0)?._cache_version) ?? undefined,
      }
    );
  },
};

// this select statement applies the "swap volume fix" to recreate
// SwapAmountIn/SwapAmountOut for events in Neutron <= v5 that do not have them
export const selectDexTickUpdatesWithSwapAmountFix = sql`
  -- get previous reserves value by using an ordered window to select previous (by order) row data
  -- to help determine the ReservesDiff field: the current - previous Reserves value
  WITH lagInFrame("Reserves", 1, 0) OVER (
    -- partition by "pools" of reserves (they are separate per tick + fee/tranche combination)
    PARTITION BY "TokenZero", "TokenOne", "TokenIn", "TickIndex", "Fee", "TrancheKey"
    -- within the pool index partition, sort by event order
    ORDER BY "height" ASC, "block_part_index" ASC, "tx_index" ASC, "event_index" ASC
  ) as "PreviousReserves"
  -- compare this to current row data to get relative state (ReservesDiff) and
  -- use the already derived is_swap field to compute new SwapAmountIn and SwapAmountOut attributes
  SELECT
    *,
    -- get difference from last Reserves value
    ("Reserves" - "PreviousReserves") as "ReservesDiff",
    -- note: all swap TickUpdate events should be DEX decrements (ReservesDiff < 0)
    if (
      "is_swap" AND "ReservesDiff" < 0,
      toUInt128(abs("ReservesDiff")),
      "SwapAmountOut"
    ) as "SwapAmountOut",
    -- note: SwapAmountIn may have rounding errors (but this very small in practice)
    if (
      "is_swap" AND "ReservesDiff" < 0,
      toUInt128(ceiling(multiply(toFloat64(abs("ReservesDiff")), pow(1.0001, "TickIndex")))),
      "SwapAmountIn"
    ) as "SwapAmountIn"
  FROM spacebox."dex_message_event_tick_update"
`;
