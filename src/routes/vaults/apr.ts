import sql, { raw } from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import {
  getFillableTimePeriod,
  hours,
  inMs,
  minutes,
  WithFillTimePeriod,
  toUnixTime,
} from '../../utils/units';
import dexSwapTimeseries from '../../common-table-expressions/dexSwapTimeseries';
import bankReservesDeltasTimeseries from '../../common-table-expressions/bankReservesDeltas';

interface Request {
  params: { contract: string };
  query: {
    from?: string;
    to?: string;
    periods?: string;
    period?: WithFillTimePeriod;
    limit?: string;
  };
}
interface Response {
  time: string;
  apr_0_usd: number;
  apr_1_usd: number;
}
const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/apr/:contract',
  handler: async (request, abortSignal, previousResponse) => {
    const sourceTableHeight = await getCachedResponse<{ height: string }>(
      sql`
        SELECT max("height") AS "height"
        FROM spacebox."raw_block_results"
      `,
      abortSignal
    );

    // get timeseries data height (quick query to determine cache version)
    const contract = await getCachedResponse<{
      timestamp: string;
      height: string;
      contract: string;
      token_0_denom: string;
      token_1_denom: string;
      token_0_symbol: string;
      token_1_symbol: string;
      token_0_quote_currency: string;
      token_1_quote_currency: string;
    }>(
      sql`
          SELECT *
          FROM spacebox."supervaults_message_event_instantiate"
          WHERE "contract" = ${request.params.contract}
        `,
      abortSignal,
      {
        cacheTime: 10 * minutes * inMs,
      }
    );

    const data = contract.data.at(0);
    if (!data) {
      throw new Error('NotFound', { cause: 404 });
    }
    const denom0 = data.token_0_denom;
    const denom1 = data.token_1_denom;
    const pair0 = `${data.token_0_symbol}-${data.token_0_quote_currency}`;
    const pair1 = `${data.token_1_symbol}-${data.token_1_quote_currency}`;

    // get timeseries data height (quick query to determine cache version)
    const allUpdateHeights = await Promise.all([
      getCachedResponse<{
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
      ),
      getCachedResponse<{
        height: string;
        time: string;
      }>(
        sql`
            SELECT
              max(t."height") AS "height",
              argMax("timestamp", t."height") as "time"
            FROM spacebox.bank_transfer as t
            WHERE "address" = ${request.params.contract}
              AND ("denom" = ${denom0} OR "denom" = ${denom1})
        `,
        abortSignal
      ),
      getCachedResponse<{
        height: string;
        time: string;
      }>(
        sql`
            SELECT
              max(t."height") AS "height",
              argMax("timestamp", t."height") as "time"
            FROM spacebox."raw_slinky_prices" as t
            WHERE "pair_id" = ${pair0}
              OR "pair_id" = ${pair1}
        `,
        abortSignal
      ),
    ]);

    const currentHeight = allUpdateHeights
      .slice()
      .sort((a, b) => {
        const rowA = a.data.at(0);
        const rowB = b.data.at(0);
        return rowA && rowB
          ? Number(rowB.height) - Number(rowA.height)
          : rowA
          ? -1
          : 1;
      })
      .at(0);

    // get requested time period or default
    const timePeriods = Number(request.query.periods) || 1;
    const timePeriod = getFillableTimePeriod(request.query.period) || 'day';
    // get previous query limit
    const timePrevious = toUnixTime(previousResponse?.data.at(0)?.time);
    // get contract start time
    const timeContractStart = toUnixTime(data.timestamp);
    // ClickHouse will compare either native strings or Unix timestamps
    const unixFrom = Math.max(
      timeContractStart,
      Number(request.query.from) || 0
    );
    const unixTo = Number(request.query.to) || 0;

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        WITH
        -- add fake columns to join the price data across
        -- without some specific ID rows ClickHouse will complain: "ASOF join needs at least one equi-join column"
        -- but we alread filter to the required IDs in the following CTEs
        ${pair0} as "quote_pair_zero",
        ${pair1} as "quote_pair_one",
        bank_balance_deltas_union AS (${bankReservesDeltasTimeseries(
          data.contract,
          denom0,
          denom1
        )}),
        address_swap_volume AS (${dexSwapTimeseries(
          data.contract,
          data.token_0_denom,
          data.token_1_denom
        )}),
        amount_timeseries_at_event AS (
          SELECT
            "timestamp",
            "height",
            "sort_key",
            -- pair side
            "TokenZero",
            "TokenOne",
            "TokenIn",
            -- values
            sum(t."address_reserves") as "address_reserves",
            sum(t."address_volume_and_fees") as "address_volume_and_fees",
            sum(t."address_fees") as "address_fees"
          FROM address_swap_volume as t
          WHERE t."address_reserves" > 0
          -- order by event time
          GROUP BY "TokenZero", "TokenOne", "TokenIn", "timestamp", "height", "sort_key"
          ORDER BY "TokenZero", "TokenOne", "TokenIn", "timestamp", "height", "sort_key" ASC
        ),
        amount_timeseries_at_event_with_bank_balance_deltas AS (
          SELECT
            "timestamp",
            "height",
            "sort_key",
            -- pair side
            "TokenZero",
            "TokenOne",
            "TokenIn",
            -- values
            0 as "address_reserves",
            0 as "address_volume_and_fees",
            0 as "address_fees",
            "balance_delta"
          FROM bank_balance_deltas_union
          UNION ALL
          SELECT
            "timestamp",
            "height",
            "sort_key",
            -- pair side
            "TokenZero",
            "TokenOne",
            "TokenIn",
            -- values
            "address_reserves",
            "address_volume_and_fees",
            "address_fees",
            0 as "balance_delta"
          FROM amount_timeseries_at_event
        ),
        amount_timeseries_at_event_with_bank_balance AS (
          SELECT
            "timestamp",
            "height",
            "sort_key",
            -- pair side
            "TokenZero",
            "TokenOne",
            "TokenIn",
            -- values
            "address_reserves",
            "address_volume_and_fees",
            "address_fees",
            sum("balance_delta") OVER cumulative_events as "address_balance"
          FROM amount_timeseries_at_event_with_bank_balance_deltas
          WINDOW cumulative_events AS (
            -- partition sums to each pool
            PARTITION BY "TokenZero", "TokenOne", "TokenIn"
            ORDER BY "sort_key" ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          )
        ),
        -- get a standard period time of how much the vault has per time period
        apr_timeseries AS (
          WITH
            if("TokenIn" = "TokenZero", "address_balance", 0) as "BalanceZero",
            if("TokenIn" = "TokenOne",  "address_balance", 0) as "BalanceOne",
            if("TokenIn" = "TokenZero", "address_reserves", 0) as "ReservesZero",
            if("TokenIn" = "TokenOne",  "address_reserves", 0) as "ReservesOne",
            if("TokenIn" = "TokenZero", "address_volume_and_fees", 0) as "VolumeZero",
            if("TokenIn" = "TokenOne",  "address_volume_and_fees", 0) as "VolumeOne",
            if("TokenIn" = "TokenZero", "address_fees", 0) as "FeesZero",
            if("TokenIn" = "TokenOne",  "address_fees", 0) as "FeesOne"
          SELECT
            "timestamp",
            "height",
            "sort_key",
            -- pair
            "TokenZero",
            "TokenOne",
            -- values
            if (
              "ReservesZero" > 0 OR "BalanceZero" > 0
              "FeesZero" / ("ReservesZero" + "BalanceZero"),
              0
            ) as "AprZero",
            if (
              "ReservesOne" > 0 OR "BalanceOne" > 0
              "FeesOne" / ("ReservesOne" + "BalanceOne"),
              0
            ) as "AprOne"
          FROM amount_timeseries_at_event_with_bank_balance as t
          WHERE "address_fees" > 0 AND (
            "address_balance" > 0 OR
            "address_reserves" > 0
          )
        ),
        -- get a standard period time of how much the vault has per time period
        apr_timeseries_of_period AS (
          SELECT
            toStartOfInterval(t."timestamp", INTERVAL ${raw(
              timePeriods.toFixed(0)
            )} ${raw(timePeriod)}) AS "timestamp",
            max(t."height") AS "height",
            -- now that we will split the value fields to two sides:
            -- bring in the contract value sides
            "quote_pair_zero" as "PairZero",
            "quote_pair_one" as "PairOne",
            -- values
            sum(t."AprZero") as "AprZero",
            sum(t."AprOne") as "AprOne"
          FROM apr_timeseries as t
          WHERE 1 = 1
          ${
            unixFrom || timePrevious
              ? sql`AND t."timestamp" >= toStartOfInterval(
                  toDateTime(${unixFrom || timePrevious}),
                  INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
                )`
              : raw('')
          }
          ${
            unixTo
              ? sql`AND t."timestamp" < toStartOfInterval(
                  toDateTime(${unixTo}),
                  INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
                )`
              : raw('')
          }
          -- order by time
          GROUP BY "PairZero", "PairOne", "timestamp"
          ORDER BY "PairZero", "PairOne", "timestamp" ASC
        ),
        -- pre-aggregate specific pair prices to output time periods
        -- note: this dramatically reduces the ASOF join times
        grouped_prices AS (
          SELECT
            "pair_id",
            toStartOfInterval(t."timestamp", INTERVAL ${raw(
              timePeriods.toFixed(0)
            )} ${raw(timePeriod)}) AS "timestamp",
            argMax("price", t."timestamp") AS "price",
            argMax("decimals", t."timestamp") AS "decimals"
          FROM spacebox.raw_slinky_prices as t
          -- filter to symbol and contract start time
          WHERE ("pair_id" = "quote_pair_zero" OR "pair_id" = "quote_pair_one")
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
          GROUP BY "pair_id", "timestamp"
          ORDER BY "timestamp" ASC
        ),
        swap_volume_amount_timeseries AS (
          SELECT
            amounts."timestamp" as "timestamp",
            amounts."height" as "height",
            amounts."AprZero" as "AprZero",
            amounts."AprOne" as "AprOne",
            (
              toFloat64(p0."price") * exp10(-p0."decimals") * ("AprZero")
            ) as "apr_0_usd",
            (
              toFloat64(p0."price") * exp10(-p0."decimals") * ("AprZero")
            ) as "apr_1_usd"
          FROM apr_timeseries_of_period as amounts
          -- join to closest available price or token zero
          -- todo: can improve accuracy by joining on exact event prices
          ASOF LEFT JOIN grouped_prices as p0
            ON amounts."AprZero" > 0
            AND p0."pair_id" = amounts."PairZero"
            AND p0."timestamp" <= amounts."timestamp"
          -- join to closest available price or token one
          ASOF LEFT JOIN grouped_prices as p1
            ON amounts."AprOne" > 0
            AND p1."pair_id" = amounts."PairOne"
            AND p1."timestamp" <= amounts."timestamp"
        )
        -- return renamed fields of rows where liquidity value exists
        SELECT
          "timestamp" as "time",
          "height",
          "apr_0_usd",
          "apr_1_usd"
        FROM swap_volume_amount_timeseries
        WHERE "volume_0_usd" > 0
            OR "volume_1_usd" > 0
        -- default sort reverse chronologically
        ORDER BY "time" DESC
        -- cap limit to max, set default if not well defined
        LIMIT ${Math.min(Number(request.query.limit), MAX_ROWS) || DEFAULT_ROWS}
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        getRow: ({ time, apr_0_usd, apr_1_usd }) => ({
          time,
          apr_0_usd,
          apr_1_usd,
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
                row.name.endsWith('_0_usd')
                  ? { ...row, units: `${denom0} USD` }
                  : row
              )
              ?.map((row) =>
                row.name.endsWith('_1_usd')
                  ? { ...row, units: `${denom1} USD` }
                  : row
              )
              // add time units, convert tick index units
              ?.map((row) =>
                row.name === 'time'
                  ? { ...row, units: 'YYYY-MM-DD hh:mm:ss UTC' }
                  : { ...row }
              )
          );
        },
        // flag as complete if there will be no data changes after this
        isComplete:
          !!unixTo && toUnixTime(currentHeight?.data.at(0)?.time) > unixTo,
        cacheTime: 1 * hours * inMs,
        cacheVersion: Number(currentHeight?.data.at(0)?.height) || 0,
      }
    );
  },
};
