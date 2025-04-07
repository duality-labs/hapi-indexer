import sql, { raw } from 'sql-template-tag';

import { Route } from '../types';
import { getCachedResponse } from '../utils/cache-query';
import {
  getTimePeriod,
  hours,
  inMs,
  TimePeriod,
  toUnixTime,
} from '../utils/units';

interface Request {
  params: { denomA: string; denomB: string };
  query: {
    from?: string;
    to?: string;
    periods?: string;
    period?: TimePeriod;
    limit?: string;
  };
}
interface Response {
  time: string;
}
const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/tvl/:denomA/:denomB',
  handler: async (request, abortSignal, previousResponse) => {
    const [denom0, denom1] = [
      request.params.denomA,
      request.params.denomB,
    ].sort();

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
          max(t."height") AS "height",
          argMax("timestamp", t."height") as "time"
        FROM spacebox."dex_message_event_tick_update" as t
        WHERE "TokenZero" = ${denom0}
          AND "TokenOne" = ${denom1}
      `,
      abortSignal
    );

    // get requested time period or default
    const timePeriods = Number(request.query.periods) || 1;
    const timePeriod = getTimePeriod(request.query.period) || 'day';
    // get previous query limit
    const timePrevious = toUnixTime(previousResponse?.data.at(0)?.time);
    // get requested times or zero
    const unixFrom = Number(request.query.from) || 0;
    const unixTo = Number(request.query.to) || 0;

    // get timeseries data
    return await getCachedResponse<
      {
        time: string;
        height: string;
        Reserves0: string;
        Reserves1: string;
      },
      {
        time: string;
        Reserves0: string;
        Reserves1: string;
      }
    >(
      sql`
        WITH
        -- find deltas of each liquidity pool reserves change, the reserve
        -- deltas can be treated as "any reserves" and summed across the pair
        reserve_deltas AS (
          SELECT
            -- sorting
            "timestamp",
            "height",
            "sort_key",
            -- pool index
            "TokenZero",
            "TokenOne",
            "TokenIn",
            "TickIndex",
            "Fee",
            "TrancheKey",
            -- reserves diff across each individual pool
            "Reserves" - lagInFrame("Reserves", 1, toUInt256(0)) OVER (
              -- partition by pool
              PARTITION BY
                "TokenZero",
                "TokenOne",
                "TokenIn",
                "TickIndex",
                "Fee",
                "TrancheKey"
              -- sort by event order
              ORDER BY "sort_key" ASC
            ) AS "ReservesDelta"
          FROM spacebox.dex_message_event_tick_update
          -- filter data early to reduce processing
          WHERE
            -- filter to pair
            "TokenZero" = ${denom0} AND
            "TokenOne" = ${denom1}
            -- add optional timestamp filters only if defined
            ${
              unixFrom || timePrevious
                ? sql`AND "timestamp" >= toStartOfInterval(
                      toDateTime(${unixFrom || timePrevious}),
                      INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
                    )`
                : raw('')
            }
              ${
                unixTo
                  ? sql`AND "timestamp" < toStartOfInterval(
                      toDateTime(${unixTo}),
                      INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
                    )`
                  : raw('')
              }
        ),
        -- perform cumulative sum across reserves of all pools within the pair
        cumulative_reserves AS (
          SELECT
            "timestamp",
            "height",
            "sort_key",
            sumIf("ReservesDelta", "TokenIn" = ${denom0})
              OVER cumulative_pool_heights AS "Reserves0",
            sumIf("ReservesDelta", "TokenIn" = ${denom1})
              OVER cumulative_pool_heights AS "Reserves1"
          FROM reserve_deltas
          WINDOW cumulative_pool_heights AS (
            PARTITION BY "TokenZero", "TokenOne"
            ORDER BY "sort_key" ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          )
        ),
        -- get reserves at the end of each time period
        last_reserves_of_time_period AS (
          SELECT
            max("height") AS "last_height",
            toStartOfInterval("timestamp", INTERVAL ${raw(
              timePeriods.toFixed(0)
            )} ${raw(timePeriod)}) AS "time",
            -- get last known reserves values within group
            argMax("Reserves0", "sort_key") AS "Reserves0",
            argMax("Reserves1", "sort_key") AS "Reserves1"
          FROM cumulative_reserves
          GROUP BY "time"
        ),
        filled_reserves_timeseries as (
          SELECT
            "time",
            "Reserves0",
            "Reserves1",
            "last_height" AS "height"
          FROM last_reserves_of_time_period
          -- order by time
          ORDER BY "time" ASC
          -- but fill timeseries spaces with interpolated values
          WITH
            FILL TO NOW()
            STEP INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
            INTERPOLATE (
              "Reserves0" AS "Reserves0",
              "Reserves1" AS "Reserves1"
            )
        )
        SELECT * FROM filled_reserves_timeseries
        -- default sort reverse chronologically
        ORDER BY "time" DESC
        -- cap limit to max, set default if not well defined
        LIMIT ${Math.min(Number(request.query.limit), MAX_ROWS) || DEFAULT_ROWS}
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        getRow: ({ time, Reserves0, Reserves1 }) => ({
          time,
          Reserves0,
          Reserves1,
        }),
        getHeight: (data) =>
          Number(data.find((row) => Number(row.height) > 0)?.height),
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => name !== 'height')
              // add reserve field denoms
              ?.map((row) =>
                row.name === 'Reserves0' ? { ...row, units: denom0 } : row
              )
              ?.map((row) =>
                row.name === 'Reserves1' ? { ...row, units: denom1 } : row
              )
              // add time units, convert tick index units
              ?.map((row) =>
                row.name === 'time'
                  ? { ...row, units: 'YYYY-MM-DD hh:mm:ss UTC' }
                  : { ...row, type: 'Int32' }
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
