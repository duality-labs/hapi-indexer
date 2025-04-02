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
import { selectDexTickUpdatesWithSwapAmountFix } from './swap-volume';

const LIMIT_ROWS = 10;

export const route = {
  method: 'GET',
  path: '/apr/:denomA/:denomB',
  handler: handleResponse<
    {
      Params: { denomA: string; denomB: string };
      Query: {
        from?: string;
        to?: string;
        periods?: string;
        period?: TimePeriod;
        limit?: string;
      };
    },
    { time: string }
  >(async (request, abortSignal, previousResponse) => {
    const limit = Number(request.query.limit) || LIMIT_ROWS;
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
        TokenIn: string;
        TickIndex: string;
        Fee: string;
        TrancheKey: string;
        Reserves: string;
        height: string;
      },
      {
        time: string;
        TokenIn: string;
        TickIndex: string;
        Fee: string;
        TrancheKey: string;
        Reserves: string;
      }
    >(
      sql`
        WITH previous_tick_update AS (
          -- WITH (
          --   ("event_index"        * toUInt256(1))
          --   + ("tx_index"         * toUInt256(4294967296))              -- + shift by 32 event_index bits (2^32)
          --   + ("block_part_index" * toUInt256(18446744073709551616))    -- + shift by 32 tx_index bits (2^64)
          --   + ("height"           * toUInt256(4722366482869645213696))
          -- ) as "version"
          SELECT
            -- max(height) OVER interval_window AS "last_height",
            "timestamp",
            "height", "block_part_index", "tx_index", "event_index",
            "action", -- TickUpdate
            -- pool index keys
            "TokenZero", "TokenOne", "TokenIn", "TickIndex", "Fee", "TrancheKey",
            -- reserve information
            -- Reserves
            "SwapAmountIn",
            "SwapAmountOut"
          FROM (${selectDexTickUpdatesWithSwapAmountFix}) as tick_updates
          WINDOW interval_window AS (
            PARTITION BY
              -- partition to each pool index for each time period
              "TokenZero", "TokenOne", "TokenIn", "TickIndex", "Fee", "TrancheKey"
            -- order by ascending event position within interval time
            ORDER BY
              "height" ASC,
              "block_part_index" ASC,
              "tx_index" ASC,
              "event_index" ASC
            -- use "last_value" of this window to get the previous "Reserves" value
            ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING
          )
        ),
        unioned_table as (
          SELECT "action", "timestamp", "height", "block_part_index", "tx_index", "event_index",
            "TokenZero", "TokenOne", "TokenIn",
            "TickIndex",
            if("TokenIn" = "TokenZero", "TickIndex", 2 * "Fee" - "TickIndex") AS "TickIndexZero",
            if("TokenIn" = "TokenOne", "TickIndex", 2 * "Fee" - "TickIndex") AS "TickIndexOne",
            "Fee", "TrancheKey",
            null AS "Creator", null AS "shares", "SwapAmountIn", "SwapAmountOut"
          FROM previous_tick_update AS ticks
          WHERE "TokenZero" = ${denom0}
            AND "TokenOne" = ${denom1}
            -- AND "TickIndex" = -19524
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
          UNION ALL
          SELECT "action", "timestamp", "height", "block_part_index", "tx_index", "event_index",
            "TokenZero", "TokenOne", NULL AS "TokenIn",
            "TickIndex", "TickIndexZero", "TickIndexOne", "Fee", '' AS "TrancheKey",
            "Creator", SUM("shares") OVER (
              -- sum all changes to shares to find current total number of shares
              PARTITION BY "TokenZero", "TokenOne", "TickIndex", "Fee"
              ORDER BY
                "height" ASC,
                "block_part_index" ASC,
                "tx_index" ASC,
                "event_index" ASC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) as "shares", null as "SwapAmountIn", null as "SwapAmountOut"
          FROM spacebox.dex_message_event_lp_user_balance AS lps
          WHERE "TokenZero" = ${denom0}
            AND "TokenOne" = ${denom1}
            -- AND "TickIndexOne" = -19524
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
        unioned_table_with_last_shares_on_updates as (
          SELECT *, last_value("shares") OVER (
            -- fix here:
            PARTITION BY "TokenZero", "TokenOne", "TickIndexZero", "TickIndexZero", "Fee", "TrancheKey"
              ORDER BY
                "height" ASC,
                "block_part_index" ASC,
                "tx_index" ASC,
                "event_index" ASC
              -- use "last_value" of this window to get the previous "shares" value
              -- (current shares value exists on field "shares")
              -- note: "UNBOUNDED PRECEDING" is used because the previous value
              --       may be many rows in the past (or may not exist at all)
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ) as total_shares FROM unioned_table
        )
        -- WIP: // ensure tickupdate at 21324750 gives 353 TokenOut total fees? probably don't round ever until withdrawal?
        -- I have a feeling that if we round in one direction it might sum up all the fees correctly
        -- could test using one "high use" pool
        --   - find out all the deposits from the vaults
        --   - find the current amount in the pool how much?
        SELECT * FROM unioned_table_with_last_shares_on_updates
        -- select updates that should generate swap volume fees
        WHERE "SwapAmountIn" > 0 AND "Fee" > 0
        -- WHERE "height" = 21324778
        -- SELECT
        --   "time",
        --   "height",
        --       "block_part_index",
        --       "tx_index",
        --       "event_index",
        --   "TokenZero", "TokenOne", "TokenIn", "TickIndex", "Fee", "TrancheKey",
        --   any("Reserves") as "Reserves"
        --   -- sum("Reserves") as "Reserves"
        --   -- sumIf("Reserves", "TokenIn" = "TokenZero") AS "Reserves0",
        --   -- sumIf("Reserves", "TokenIn" = "TokenOne") AS "Reserves1"
        -- FROM windowed_table
        -- GROUP BY "time" --, "TokenZero", "TokenOne", "TokenIn"
        -- ,"height",
        --       "block_part_index",
        --       "tx_index",
        --       "event_index",
        --   "TokenZero", "TokenOne", "TokenIn", "TickIndex", "Fee", "TrancheKey",
        ORDER BY "height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
        LIMIT ${
          // if user did not request a time period (default to last month)
          // then return only last needed rows to show all 24h changes
          request.query.period ? Math.min(limit, LIMIT_ROWS) : 1000
        }
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        // getRow: ({ time, TokenIn,TickIndex,Fee,TrancheKey,Reserves }) => ({ time, TokenIn,TickIndex,Fee,TrancheKey,Reserves}),
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
