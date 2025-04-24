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
import dexReservesTimeseries from '../../common-table-expressions/dexReservesTimeseries';
import bankReservesTimeseries from '../../common-table-expressions/bankReservesTimeseries';
import {
  selectVaultConfigs,
  VaultResponse,
} from '../../common-table-expressions/vaultConfigs';

export interface Request {
  params: { contract: string };
  query: {
    from?: string;
    to?: string;
    periods?: string;
    period?: WithFillTimePeriod;
    limit?: string;
  };
}
export interface Response {
  time: string;
  tvl_0: number;
  tvl_1: number;
}
const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/tvl/:contract',
  handler: async (request, abortSignal, previousResponse) => {
    const sourceTableHeight = await getCachedResponse<{ height: string }>(
      sql`
        SELECT max("height") AS "height"
        FROM spacebox."raw_block_results"
      `,
      abortSignal
    );

    // get timeseries data height (quick query to determine cache version)
    const contractResponse = await getCachedResponse<VaultResponse>(
      sql`
          SELECT *
          FROM (${selectVaultConfigs})
          WHERE "contract_address" = ${request.params.contract}
        `,
      abortSignal,
      {
        cacheTime: 1 * minutes * inMs,
      }
    );

    const data = contractResponse.data.at(0);
    if (!data) {
      throw new Error('NotFound', { cause: 404 });
    }
    const contract = data.contract_address;
    const hasTokensReversed = data.token_order[0] !== data.token_a_denom;
    const tokenA = {
      denom: data.token_a_denom,
      decimals: data.token_a_decimals,
      maxBlocksStale: data.token_a_max_blocks_stale,
      symbol: data.token_a_symbol,
      quoteCurrency: data.token_a_quote_currency,
    };
    const tokenB = {
      denom: data.token_b_denom,
      decimals: data.token_b_decimals,
      maxBlocksStale: data.token_b_max_blocks_stale,
      symbol: data.token_b_symbol,
      quoteCurrency: data.token_b_quote_currency,
    };
    const token0 = hasTokensReversed ? tokenB : tokenA;
    const token1 = hasTokensReversed ? tokenA : tokenB;

    const denom0 = token0.denom;
    const denom1 = token1.denom;
    const pair0 = `${token0.symbol}-${token0.quoteCurrency}`;
    const pair1 = `${token1.symbol}-${token1.quoteCurrency}`;

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
    const timeContractStart = toUnixTime(data.created_at);
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
        cumulative_bank_balances AS (${bankReservesTimeseries(
          contract,
          denom0,
          denom1
        )}),
        cumulative_bank_balances_at_height AS (
          SELECT
            "timestamp",
            "height",
            -- pool token index
            "TokenZero",
            "TokenOne",
            "TokenIn",
            -- values
            "address_balance" as "Balance"
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
        cumulative_vault_reserves AS (${dexReservesTimeseries(
          contract,
          denom0,
          denom1
        )}),
        -- perform cumulative sum across reserves of all pools within the pair
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
            sum("address_reserves") as "Reserves"
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
            argMax("height", t."timestamp") AS "height",
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
              "height" AS "height",
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
            amounts."height" as "height",
            toFloat64(amounts."BalanceZero") as "BalanceZero",
            toFloat64(amounts."BalanceOne") as "BalanceOne",
            amounts."ReservesZero" as "ReservesZero",
            amounts."ReservesOne" as "ReservesOne",
            toFloat64(p0."price") * exp10(-(${
              token0.decimals
            } + p0."decimals")) * ("ReservesZero" + "BalanceZero") as "tvl_0",
            toFloat64(p1."price") * exp10(-(${
              token1.decimals
            } + p1."decimals")) * ("ReservesOne" + "BalanceOne") as "tvl_1"
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
          "height",
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
                  ? { ...row, units: token0.quoteCurrency }
                  : row
              )
              ?.map((row) =>
                row.name === 'tvl_1'
                  ? { ...row, units: token1.quoteCurrency }
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
