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

const LIMIT_ROWS = 10000;
interface Request {
  Params: { base: string; quote?: string };
  Query: {
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

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/slinky/:base/:quote?',
  handler: async (request, abortSignal, previousResponse) => {
    const limit = Number(request.query.limit) || LIMIT_ROWS;
    const base = request.params.base;
    const quote = request.params.quote ?? 'USD';

    // get timeseries data height (quick query to determine cache version)
    const sourceTableHeight = await getCachedResponse<{
      height: string;
      time: string;
    }>(
      sql`
        SELECT
          max(t."height") AS "height",
          argMax("timestamp", t."height") as "time"
        FROM spacebox."raw_slinky_prices" as t
        WHERE "base" = ${base}
          AND "quote" = ${quote}
      `,
      abortSignal
    );

    // get requested time period or default
    const timePeriods = Number(request.query.periods) || 1;
    const timePeriod = getTimePeriod(request.query.period as string) || 'day';
    // get previous query limit
    const timePrevious = toUnixTime(previousResponse?.data.at(0)?.time);
    // get requested times or zero
    const unixFrom = Number(request.query.from) || 0;
    const unixTo = Number(request.query.to) || 0;

    // get timeseries data
    return await getCachedResponse<
      {
        time: string;
        open: string;
        high: string;
        low: string;
        close: string;
        height: string;
      },
      { time: string; open: number; high: number; low: number; close: number }
    >(
      sql`
        WITH windowed_table AS (
          WITH
            -- get time period offset
            (
              ${
                // if user did not request a time period, default to "last 24h"
                !request.query.period
                  ? sql`NOW() - toStartOfInterval(NOW(), INTERVAL 1 DAY)`
                  : raw('0')
              }
            ) AS "time_offset",
            -- get price in the same direction: Token1 = 1.0001^price * Token0
            t."price" / intExp10(t."decimals") AS "price"
          SELECT
            max(height) OVER interval_window AS "last_height",
            toStartOfInterval("timestamp" - "time_offset", INTERVAL ${raw(
              timePeriods.toFixed(0)
            )} ${raw(timePeriod)}) AS "time",
            first_value("price") OVER interval_window AS "open",
            last_value("price") OVER interval_window AS "close",
            min("price") OVER interval_window AS "low",
            max("price") OVER interval_window AS "high"
          FROM spacebox."raw_slinky_prices" as t
          WHERE "base" = ${base}
          AND "quote" = ${quote}
            -- add optional timestamp filters only if defined
            ${
              unixFrom || timePrevious
                ? sql`AND "timestamp" - "time_offset" >= toStartOfInterval(
                    toDateTime(${unixFrom || timePrevious}),
                    INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
                  )`
                : raw('')
            }
            ${
              unixTo
                ? sql`AND "timestamp" - "time_offset" < toStartOfInterval(
                    toDateTime(${unixTo}),
                    INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
                  )`
                : raw('')
            }
          WINDOW interval_window AS (
            PARTITION BY "time"
            -- order by ascending position within interval time
            ORDER BY "height" ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          )
        )
        SELECT
          "time",
          -- these are properly grouped inside the windowed_table selection
          any("open") AS "open",
          any("high") AS "high",
          any("low") AS "low",
          any("close") AS "close",
          any("last_height") AS "height"
        FROM windowed_table
        GROUP BY "time"
        ORDER BY "time" DESC
        LIMIT ${
          // if user did not request a time period (default to last 24h)
          // then return only last 3 rows for recent 24h changes
          request.query.period ? Math.min(limit, LIMIT_ROWS) : 3
        }
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        getRow: ({ time, open, high, low, close }) => ({
          time,
          // convert known numbers to numbers (will now be floats)
          open: Number(open),
          high: Number(high),
          low: Number(low),
          close: Number(close),
        }),
        getHeight: (data) => Number(data.at(0)?.height),
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => name !== 'height')
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
          !!unixTo && toUnixTime(sourceTableHeight.data.at(0)?.time) > unixTo,
        cacheTime: 1 * hours * inMs,
        cacheVersion: Number(sourceTableHeight?.data.at(0)?.height) || 0,
      }
    );
  },
};
