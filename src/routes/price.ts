import sql, { raw } from 'sql-template-tag';

import { handleResponse } from '../utils/response';
import { getCachedResponse } from '../utils/cache-query';
import {
  getTimePeriod,
  hours,
  inMs,
  TimePeriod,
  toUnixTime,
} from '../utils/units';

const LIMIT_ROWS = 1000;

export const route = {
  method: 'GET',
  path: '/price/:denomA/:denomB',
  handler: handleResponse<
    {
      Params: { denomA: string; denomB: string };
      Query: {
        from?: string;
        to?: string;
        period?: TimePeriod;
      };
    },
    { time: string }
  >(async (request, abortSignal, previousResponse) => {
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
        WHERE "is_swap" = 1
          AND "TokenZero" = ${denom0}
          AND "TokenOne" = ${denom1}
      `,
      abortSignal
    );

    // get requested time period or default
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
          -- get price in the same direction: Token1 = 1.0001^price * Token0
          WITH (
            if (
              "TokenIn" = "TokenZero",
              "TickIndex" * -1,
              "TickIndex"
            )
          ) AS "price"
          SELECT
            max(height) OVER interval_window AS "last_height",
            toStartOfInterval("timestamp", INTERVAL 1 ${raw(
              timePeriod
            )}) AS "time",
            first_value("price") OVER interval_window AS "open",
            last_value("price") OVER interval_window AS "close",
            min("price") OVER interval_window AS "low",
            max("price") OVER interval_window AS "high"
          FROM spacebox.dex_message_event_tick_update
          WHERE "is_swap" = 1
            AND "TokenZero" = ${denom0}
            AND "TokenOne" = ${denom1}
            -- add optional timestamp filters only if defined
            ${
              unixFrom || timePrevious
                ? sql`AND "timestamp" >= toStartOfInterval(
                    toDateTime(${unixFrom || timePrevious}),
                    INTERVAL 1 ${raw(timePeriod)}
                  )`
                : raw('')
            }
            ${
              unixTo
                ? sql`AND "timestamp" < toStartOfInterval(
                    toDateTime(${unixTo}),
                    INTERVAL 1 ${raw(timePeriod)}
                  )`
                : raw('')
            }
          WINDOW interval_window AS (
            PARTITION BY "time"
            -- order by ascending event position within interval time
            ORDER BY
              "height" ASC,
              "block_part_index" ASC,
              "tx_index" ASC,
              "event_index" ASC
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
        LIMIT ${LIMIT_ROWS}
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        getRow: ({ time, open, high, low, close }) => ({
          time,
          // convert known integers to numbers
          // note: DB type is 64 bit integer but actual limit is -559680->559680
          //  see: https://github.com/neutron-org/neutron/blob/v4.0.1/x/dex/types/price.go#L17-L22
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
          !!unixTo && toUnixTime(currentHeight.data.at(0)?.time) > unixTo,
        cacheTime: 1 * hours * inMs,
        cacheVersion: Number(currentHeight?.data.at(0)?.height) || 0,
      }
    );
  }),
};
