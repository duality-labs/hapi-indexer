import sql, { raw } from 'sql-template-tag';

import { handleResponse } from '../../utils/response';
import { getCachedResponse } from '../../utils/cache-query';
import {
  getTimePeriod,
  hours,
  inMs,
  minutes,
  TimePeriod,
  toUnixTime,
} from '../../utils/units';

interface Request {
  Params: { contract: string };
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
  tvl_0: number;
  tvl_1: number;
}
const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

export const route = {
  method: 'GET',
  path: '/vaults/tvl/:contract',
  handler: handleResponse<Request, Response>(
    async (request, abortSignal, previousResponse) => {
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
        concat(${data.token_0_symbol}, '-', ${
          data.token_0_quote_currency
        }) as "quote_pair_zero",
        concat(${data.token_1_symbol}, '-', ${
          data.token_1_quote_currency
        }) as "quote_pair_one",
        bank_balance_token_zero_deltas AS (
          SELECT
            "timestamp",
            "height",
            "sort_key",
            -- pool index
            ${denom0} as "TokenZero",
            ${denom1} as "TokenOne",
            -- choose side as TokenZero
            "TokenZero" as "TokenIn",
            -- Reserves
            "amount" AS "BalanceDelta"
          FROM spacebox.bank_transfer
          WHERE "address" = ${request.params.contract}
            AND "denom" = ${denom0}
        ),
        bank_balance_token_one_deltas AS (
          SELECT
            "timestamp",
            "height",
            "sort_key",
            -- pool index
            ${denom0} as "TokenZero",
            ${denom1} as "TokenOne",
            -- choose side as TokenOne
            "TokenOne" as "TokenIn",
            -- Reserves
            "amount" AS "BalanceDelta"
          FROM spacebox.bank_transfer
          WHERE "address" = ${request.params.contract}
            AND "denom" = ${denom1}
        ),
        bank_balance_deltas_union AS (
          SELECT * FROM bank_balance_token_zero_deltas
          UNION ALL
          SELECT * FROM bank_balance_token_one_deltas
        ),
        cumulative_bank_balances AS (
          SELECT
            "timestamp",
            "height",
            "sort_key",
            -- pool index
            "TokenZero",
            "TokenOne",
            "TokenIn",
            -- values
            sum("BalanceDelta") OVER cumulative_events as "Balance"
          FROM bank_balance_deltas_union
          WINDOW cumulative_events AS (
            -- partition sums to each pool
            PARTITION BY "TokenZero", "TokenOne", "TokenIn"
            ORDER BY "sort_key" ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          )
        ),
        cumulative_bank_balances_at_height AS (
          SELECT
            "timestamp",
            "height",
            "sort_key",
            -- pool token index
            "TokenZero",
            "TokenOne",
            "TokenIn",
            -- values
            "Balance"
          FROM (
            SELECT *,
              ROW_NUMBER() OVER (
                -- get all rows matching a certain pool and height
                PARTITION BY "height", "TokenZero", "TokenOne", "TokenIn"
                ORDER BY "sort_key" DESC
              ) AS "row_order"
            FROM cumulative_bank_balances
          )
          -- filter to last row of each height
          WHERE "row_order" = 1
        ),
        vault_shares_deltas AS (
          WITH "Receiver" = ${request.params.contract} as "is_vault"
          SELECT
            -- sorting
            "timestamp",
            "height",
            "sort_key",
            -- pool index
            "TokenZero",
            "TokenOne",
            "TickIndex",
            "Fee",
            -- values
            if ("credit" = 1, "shares" * "is_vault", -"shares" * "is_vault") as "vault_shares_delta",
            if ("credit" = 1, "shares", -"shares") as "total_shares_delta"
          FROM spacebox.dex_shares
          -- filter data early to reduce processing
          WHERE
            -- filter to pair
            "TokenZero" = ${denom0} AND
            "TokenOne" = ${denom1}
        ),
        vault_shares_zero_deltas AS (
          WITH "Receiver" = ${request.params.contract} as "is_vault"
          SELECT
            -- sorting
            "timestamp",
            "height",
            "sort_key",
            -- pool index
            "TokenZero",
            "TokenOne",
            -- choose side as TokenZero
            "TokenZero" as "TokenIn",
            -- shift central tick index to "TickIndexZero" side
            "Fee" - "TickIndex" as "TickIndex",
            "Fee",
            -- values
            "vault_shares_delta",
            "total_shares_delta"
          FROM vault_shares_deltas
        ),
        vault_shares_one_deltas AS (
          WITH "Receiver" = ${request.params.contract} as "is_vault"
          SELECT
            -- sorting
            "timestamp",
            "height",
            "sort_key",
            -- pool index
            "TokenZero",
            "TokenOne",
            -- choose side as TokenOne
            "TokenOne" as "TokenIn",
            -- shift central tick index to "TickIndexOne" side
            "Fee" + "TickIndex" as "TickIndex",
            "Fee",
            -- values
            "vault_shares_delta",
            "total_shares_delta"
          FROM vault_shares_deltas
        ),
        vault_shares_deltas_union AS (
          SELECT * FROM vault_shares_zero_deltas
          UNION ALL
          SELECT * FROM vault_shares_one_deltas
        ),
        dex_reserves_deltas AS (
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
            "TokenOne" = ${denom1} AND
            -- do not include tranches (limit order liquidity)
            empty("TrancheKey")
        ),
        vault_reserves_deltas_union AS (
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
            -- values
            "ReservesDelta",
            0 as "vault_shares_delta",
            0 as "total_shares_delta"
          FROM dex_reserves_deltas
          UNION ALL
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
            -- values
            0 as "ReservesDelta",
            "vault_shares_delta",
            "total_shares_delta"
          FROM vault_shares_deltas_union
        ),
        -- perform cumulative sum across reserves of all pools within the pair
        cumulative_vault_reserves AS (
          WITH
            sum("vault_shares_delta") OVER cumulative_events as "vault_shares",
            sum("total_shares_delta") OVER cumulative_events as "total_shares",
            sum("ReservesDelta") OVER cumulative_events as "total_reserves"
          SELECT
            "timestamp",
            "height",
            "sort_key",
            -- pool index
            "TokenZero",
            "TokenOne",
            "TokenIn",
            "TickIndex",
            "Fee",
            -- values
            if (
              "total_shares" > 0,
              "total_reserves" * "vault_shares" / "total_shares",
              0
            ) as "vault_reserves"
          FROM vault_reserves_deltas_union
          WINDOW cumulative_events AS (
            -- partition sums to each pool
            PARTITION BY "TokenZero", "TokenOne", "TokenIn", "TickIndex", "Fee"
            ORDER BY "sort_key" ASC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          )
        ),
        cumulative_vault_reserves_at_height AS (
          SELECT
            "timestamp",
            "height",
            -- pool token index
            "TokenZero",
            "TokenOne",
            "TokenIn",
            -- values
            -- sum all cumulative pool totals by token pair + token side
            sum("vault_reserves") as "Reserves"
          -- get the last row (ORDER BY "sort_key" DESC WHERE "row_order"= 1)
          -- of each pool within a current block height (last state of block)
          FROM (
            SELECT *,
              ROW_NUMBER() OVER (
                -- get all rows matching a certain pool and height
                PARTITION BY "height", "TokenZero", "TokenOne", "TokenIn", "TickIndex", "Fee"
                ORDER BY "sort_key" DESC
              ) AS "row_order"
            FROM cumulative_vault_reserves
          )
          -- filter to last row of each height
          WHERE "row_order" = 1
          GROUP BY
            "TokenZero",
            "TokenOne",
            "TokenIn",
            "timestamp",
            "height"
        ),
        cumulative_all_at_height AS (
          SELECT
            v.*,
            b."Balance" as "Balance"
          FROM cumulative_vault_reserves_at_height as v
          LEFT OUTER JOIN cumulative_bank_balances_at_height as b
          ON v.height = b.height
          AND v.timestamp = b.timestamp
          AND v.TokenZero = b.TokenZero
          AND v.TokenOne = b.TokenOne
          AND v.TokenIn = b.TokenIn
        ),
        grouped_vault_reserves_at_height as (
          SELECT
            "timestamp",
            "height",
            -- now that we will split the value fields to two sides:
            -- bring in the contract value sides
            "quote_pair_zero" as "PairZero",
            "quote_pair_one" as "PairOne",
            -- values
            sumIf("Balance", "TokenIn" = "TokenZero") as "BalanceZero",
            sumIf("Balance", "TokenIn" = "TokenOne") as "BalanceOne",
            sumIf("Reserves", "TokenIn" = "TokenZero") as "ReservesZero",
            sumIf("Reserves", "TokenIn" = "TokenOne") as "ReservesOne"
          FROM cumulative_all_at_height as reserves
          GROUP BY
            "PairZero",
            "PairOne",
            "timestamp",
            "height"
          ORDER BY "height" ASC
        ),
        -- get a standard period time of how much the vault has per time period
        filled_amount_timeseries_of_period AS (
          SELECT
            toStartOfInterval(t."timestamp", INTERVAL ${raw(
              timePeriods.toFixed(0)
            )} ${raw(timePeriod)}) AS "timestamp",
            "PairZero",
            "PairOne",
            -- get last known reserves values within group
            argMax("BalanceZero", t."timestamp") AS "BalanceZero",
            argMax("BalanceOne", t."timestamp") AS "BalanceOne",
            argMax("ReservesZero", t."timestamp") AS "ReservesZero",
            argMax("ReservesOne", t."timestamp") AS "ReservesOne"
          FROM grouped_vault_reserves_at_height as t
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
          -- but fill timeseries spaces with interpolated values
          WITH
            FILL TO NOW()
            STEP INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
            INTERPOLATE (
              "BalanceZero" AS "BalanceZero",
              "BalanceOne" AS "BalanceOne",
              "ReservesZero" AS "ReservesZero",
              "ReservesOne" AS "ReservesOne"
            )
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
        tvl_amount_timeseries AS (
          SELECT
            amounts."timestamp" as "timestamp",
            toFloat64(amounts."BalanceZero") as "BalanceZero",
            toFloat64(amounts."BalanceOne") as "BalanceOne",
            amounts."ReservesZero" as "ReservesZero",
            amounts."ReservesOne" as "ReservesOne",
            toFloat64(p0."price") * exp10(-p0."decimals") * ("ReservesZero" + "BalanceZero") as "tvl_0",
            toFloat64(p1."price") * exp10(-p1."decimals") * ("ReservesOne" + "BalanceOne") as "tvl_1"
          FROM filled_amount_timeseries_of_period as amounts
          -- join to closest available price or token zero
          ASOF LEFT JOIN grouped_prices as p0
            ON (amounts."ReservesZero" > 0 OR amounts."BalanceZero" > 0)
            AND p0."pair_id" = amounts."PairZero"
            AND p0."timestamp" <= amounts."timestamp"
          -- join to closest available price or token one
          ASOF LEFT JOIN grouped_prices as p1
            ON (amounts."ReservesOne" > 0 OR amounts."BalanceOne" > 0)
            AND p1."pair_id" = amounts."PairOne"
            AND p1."timestamp" <= amounts."timestamp"
        )
        -- return renamed fields of rows where liquidity value exists
        SELECT
          "timestamp" as "time",
            "tvl_0",
            "tvl_1"
          FROM tvl_amount_timeseries
          WHERE "tvl_0" > 0
             OR "tvl_1" > 0
        -- default sort reverse chronologically
        ORDER BY "time" DESC
        -- cap limit to max, set default if not well defined
        LIMIT ${Math.min(Number(request.query.limit), MAX_ROWS) || DEFAULT_ROWS}
      `,
        abortSignal,
        {
          heartbeat: Number(sourceTableHeight.data.at(0)?.height),
          getRow: ({ time, tvl_0, tvl_1 }) => ({ time, tvl_0, tvl_1 }),
          getHeight: (data) =>
            Number(data.find((row) => Number(row.height) > 0)?.height),
          getMetadata: (metadata) => {
            return (
              metadata
                // remove height field
                ?.filter(({ name }) => name !== 'height')
                // add reserve field denoms
                ?.map((row) =>
                  row.name === 'tvl_0'
                    ? { ...row, units: `${denom0} USD` }
                    : row
                )
                ?.map((row) =>
                  row.name === 'tvl_1'
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
            !!unixTo && toUnixTime(currentHeight.data.at(0)?.time) > unixTo,
          cacheTime: 1 * hours * inMs,
          cacheVersion: Number(currentHeight?.data.at(0)?.height) || 0,
        }
      );
    }
  ),
};
