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

const LIMIT_ROWS = 10;

// vault TVL is the value of DenomA and DenomB tokens held by a vault contract
// the value of these tokens will change with time with the market even if the
// token amounts do not change
export const route = {
  method: 'GET',
  path: 'supervaults/tvl/:denomA/:denomB',
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
        WITH lp_balance_timeseries AS (
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
            "TokenZero", "TokenOne",
            -- reserve information
            -- Reserves
            sum("ReservesZeroDeposited") OVER user_pair_window AS "ReservesZeroDeposited",
            sum("ReservesOneDeposited") OVER user_pair_window AS "ReservesOneDeposited",
            -- "grouped by user"
            "Receiver"
          FROM spacebox.dex_message_event_lp_user_balance
          -- todo: fix missing DepositLP from WASM events before height 19947000 issue
          WHERE height >= 19964191
            AND "Receiver" = 'neutron1jmpf37kfscaqe884nkmxa694nfnk4kt75gd4umf097uyvzz9ahlqnet797'
          WINDOW user_pair_window AS (
            PARTITION BY
              -- partition to each user's pair deposit balance
              "TokenZero", "TokenOne", "Receiver"
            -- order by ascending event position within interval time
            ORDER BY
              "height" ASC,
              "block_part_index" ASC,
              "tx_index" ASC,
              "event_index" ASC
            -- get all known values up to the row's point in time
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          )
        )
        SELECT * FROM lp_balance_timeseries
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
