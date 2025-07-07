import sql, { raw } from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import {
  getTimePeriod,
  hours,
  inMs,
  TimePeriod,
  toUnixTime,
} from '../../utils/units';

const LIMIT_ROWS = 10000;

interface Request {
  params: { denomA: string; denomB: string };
  query: {
    from?: string;
    to?: string;
    periods?: string;
    period?: TimePeriod;
    limit?: string;
    show_trades_above_value?: string;
  };
}
interface Response {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: string;
}

const defaultMinTradeValueUSD = 1;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/dex/price/:denomA/:denomB',
  handler: async (request, abortSignal, previousResponse) => {
    // get minimum USD value per candle
    const minTradeValueUSD =
      Number(
        request.query.show_trades_above_value ?? defaultMinTradeValueUSD
      ) || 0;

    const limit = Number(request.query.limit) || LIMIT_ROWS;
    const [denom0, denom1] = [
      request.params.denomA,
      request.params.denomB,
    ].sort();
    // expect pair price in BtoA direction
    const isPairDenomReversed = denom0 === request.params.denomA;

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
    const timePeriods = Number(request.query.periods) || 1;
    const timePeriod = getTimePeriod(request.query.period) || 'day';
    // get previous query limit
    const timePrevious = toUnixTime(previousResponse?.data.at(0)?.time);
    // get requested times or zero
    const unixFrom = Number(request.query.from) || 0;
    const unixTo = Number(request.query.to) || 0;

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        WITH
        swaps AS (
          SELECT
            "height",
            "block_part_index",
            "tx_index",
            "event_index",
            "timestamp",
            "TokenZero",
            "TokenOne",
            "TickIndex",
            "ReservesInZero",
            "ReservesInOne",
            "ReservesOutZero",
            "ReservesOutOne",
            "value_in_0",
            "value_in_1",
            "value_fee_0",
            "value_fee_1",
            "value_out_0",
            "value_out_1",
            "price_version"
          FROM spacebox.dex_swaps_valued
          WHERE "action" = 'TickUpdate'
            AND "TokenZero" = ${denom0}
            AND "TokenOne" = ${denom1}
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
        ),
        -- ensure prices and swap amounts are not counted twice
        deduplicated_swaps AS (
          SELECT
            "height",
            "block_part_index",
            "tx_index",
            "event_index",
            argMax("timestamp", "price_version") as "timestamp",
            argMax("TokenZero", "price_version") as "TokenZero",
            argMax("TokenOne", "price_version") as "TokenOne",
            argMax("TickIndex", "price_version") as "TickIndex",
            argMax("ReservesInZero", "price_version") as "ReservesInZero",
            argMax("ReservesInOne", "price_version") as "ReservesInOne",
            argMax("ReservesOutZero", "price_version") as "ReservesOutZero",
            argMax("ReservesOutOne", "price_version") as "ReservesOutOne",
            argMax("value_in_0", "price_version") as "value_in_0",
            argMax("value_in_1", "price_version") as "value_in_1",
            argMax("value_fee_0", "price_version") as "value_fee_0",
            argMax("value_fee_1", "price_version") as "value_fee_1",
            argMax("value_out_0", "price_version") as "value_out_0",
            argMax("value_out_1", "price_version") as "value_out_1",
            max("price_version") > 0 as "trade_is_valued"
          FROM swaps
          GROUP BY "height", "block_part_index", "tx_index", "event_index"
        ),
        windowed_table AS (
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
            "TickIndex" AS "price",
            -- get swap volume in terms of denomA
            ${
              request.params.denomA === denom0
                ? raw('"ReservesInZero" + "ReservesOutZero"')
                : raw('"ReservesInOne" + "ReservesOutOne"')
            } AS "swap_amount_a"
          SELECT
            max("height") OVER interval_window AS "last_height",
            toStartOfInterval("timestamp" - "time_offset", INTERVAL ${raw(
              timePeriods.toFixed(0)
            )} ${raw(timePeriod)}) AS "time",
            first_value("price") OVER interval_window AS "open",
            last_value("price") OVER interval_window AS "close",
            quantileTDigestWeighted(0.01)("price", "swap_amount_a") OVER interval_window AS "low",
            quantileTDigestWeighted(0.99)("price", "swap_amount_a") OVER interval_window AS "high",
            sum("swap_amount_a") OVER interval_window as "swap_volume",
            0.5 * sum(
              "value_in_0" + "value_in_1"
              - ("value_fee_0" + "value_fee_1")
              + ("value_out_0" + "value_out_1")
            ) OVER interval_window as "swap_value",
            "trade_is_valued"
          FROM deduplicated_swaps
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
        ),
        timeseries AS (
          SELECT
            "time",
            -- these are properly grouped inside the windowed_table selection
            any("open") AS "open",
            toInt64(round(any("high"))) AS "high",
            toInt64(round(any("low"))) AS "low",
            any("close") AS "close",
            any("last_height") AS "height",
            any("swap_volume") AS "swap_volume",
            any("swap_value") AS "swap_value",
            any("trade_is_valued") AS "trade_is_valued"
          FROM windowed_table
          GROUP BY "time"
        ),
        least("high", "low") AS "_min",
        greatest("high", "low") AS "_max"
        SELECT
          "height",
          "time",
          -- these are properly grouped inside the windowed_table selection
          clamp("open", "_min", "_max") AS "open",
          "high",
          "low",
          clamp("close", "_min", "_max") AS "close",
          "swap_volume" AS "volume"
        FROM timeseries
        WHERE "swap_value" > ${minTradeValueUSD}
          -- allow unvalued trades to be seen
          OR "trade_is_valued" = 0
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
        getRow: ({ time, open, high, low, close, volume }) => ({
          time,
          // convert known integers to numbers
          // note: DB type is 64 bit integer but actual limit is -559680->559680
          //  see: https://github.com/neutron-org/neutron/blob/v4.0.1/x/dex/types/price.go#L17-L22
          open: isPairDenomReversed ? -1 * Number(open) : Number(open),
          high: isPairDenomReversed ? -1 * Number(low) : Number(high),
          low: isPairDenomReversed ? -1 * Number(high) : Number(low),
          close: isPairDenomReversed ? -1 * Number(close) : Number(close),
          volume,
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
  },
};
