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
      // get requested times or zero
      const unixFrom = Number(request.query.from) || 0;
      const unixTo = Number(request.query.to) || 0;

      // get timeseries data
      return await getCachedResponse<
        Response & { height: string },
        Response
      >(
        sql`
        -- EXPLAIN json = 1, description = 1, header = 1, indexes = 1, actions = 1
        WITH
        -- add fake columns to join the price data across
        -- without some specific ID rows ClickHouse will complain: "ASOF join needs at least one equi-join column"
        -- but we alread filter to the required IDs in the following CTEs
        concat(${data.token_0_symbol}, '-', ${data.token_0_quote_currency}) as "quote_pair_zero",
        concat(${data.token_1_symbol}, '-', ${data.token_1_quote_currency}) as "quote_pair_one",
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
        -- dex_shares AS (
        --   WITH
        --     sumIf("shares", "credit" = 1 AND "Receiver" = ${request.params.contract}) OVER cumulative_events_window as "vault_credits",
        --     sumIf("shares", "credit" = 0 AND "Receiver" = ${request.params.contract}) OVER cumulative_events_window as "vault_debits",
        --     sumIf("shares", "credit" = 1) OVER cumulative_events_window as "total_credits",
        --     sumIf("shares", "credit" = 0) OVER cumulative_events_window as "total_debits"
        --   SELECT
        --     "timestamp",
        --     "sort_key",
        --     -- matching attributes
        --     "TokenZero",
        --     "TokenOne",
        --     "TickIndex",
        --     "Fee",
        --     -- current values
        --     "vault_credits" - "vault_debits" as "vault_shares",
        --     "total_credits" - "total_debits" as "total_shares"
        --   FROM spacebox.dex_shares
        --   -- todo: fix missing DepositLP from WASM events before height 19947000 issue
        --   -- WHERE height >= 19964191
        --     -- AND "Receiver" = 'neutron1jmpf37kfscaqe884nkmxa694nfnk4kt75gd4umf097uyvzz9ahlqnet797'
        --     -- AND "Receiver" = 'neutron1eqecswp0ajvlvf344k80c5w4c948zwg4lq3zgg6mdd20hcqef2mqd8rvca'
        --   WHERE "TokenZero" = ${denom0}
        --     AND "TokenOne" = ${denom1}
        --   WINDOW cumulative_events_window AS (
        --     -- partition sums to each pool
        --     PARTITION BY "TokenZero", "TokenOne", "TickIndex", "Fee"
        --     ORDER BY "sort_key" ASC
        --     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        --   )
        -- ),
        -- vault_shares AS (
        --   SELECT
        --     -- sorting
        --     "timestamp",
        --     "height",
        --     "sort_key",
        --     -- pool index
        --     "TokenZero",
        --     "TokenOne",
        --     "Fee" - "TickIndex" = "TickIndexZero",
        --     "Fee" + "TickIndex" = "TickIndexOne",
        --     "Fee",
        --     "Receiver" = ${request.params.contract} as "is_vault", 
        --     if ("credit" = 1, "shares", -"shares") as "shares_change"
        --   FROM spacebox.dex_shares
        --   -- filter data early to reduce processing
        --   WHERE
        --     -- filter to pair
        --     "TokenZero" = ${denom0} AND
        --     "TokenOne" = ${denom1}
        -- ),
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
            -- convert TickIndexZero/TickIndexOne to TickIndex(centre)
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
            -- do not include tranches
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
            sum("vault_reserves") as "Reserves"
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
            "timestamp",
            "height",
            "TokenZero",
            "TokenOne",
            "TokenIn"
        ),
        cumulative_all_at_height AS (
          SELECT v.*, b."Balance" as "Balance" FROM cumulative_vault_reserves_at_height as v
          LEFT OUTER JOIN cumulative_bank_balances_at_height as b
          ON v.height = b.height
          AND v.timestamp = b.timestamp
          AND v.TokenZero = b.TokenZero
          AND v.TokenOne = b.TokenOne
          AND v.TokenIn = b.TokenIn
        ),
        -- dex_reserves AS (
        --   SELECT
        --     -- sorting
        --     "timestamp",
        --     "height",
        --     "sort_key",
        --     -- pool index
        --     "TokenZero",
        --     "TokenOne",
        --     "TokenIn",
        --     -- convert TickIndexZero/TickIndexOne to TickIndex(centre)
        --     "TickIndex",
        --     "Fee",
        --     -- reserves diff across each individual pool
        --     "Reserves"
        --   FROM spacebox.dex_message_event_tick_update
        --   -- filter data early to reduce processing
        --   WHERE
        --     -- filter to pair
        --     "TokenZero" = ${denom0} AND
        --     "TokenOne" = ${denom1} AND
        --     -- do not include tranches
        --     empty("TrancheKey")
        -- ),
        -- vault_shares_deltas AS (
        --   WITH "Receiver" = ${request.params.contract} as "is_vault"
        --   SELECT
        --     -- sorting
        --     "timestamp",
        --     "height",
        --     "sort_key",
        --     -- pool index
        --     "TokenZero",
        --     "TokenOne",
        --     "Fee" - "TickIndex" as "TickIndexZero",
        --     "Fee" + "TickIndex" as "TickIndexOne",
        --     "Fee",
        --     if ("credit" = 1, "shares" * "is_vault", -"shares" * "is_vault") as "vault_shares_delta",
        --     if ("credit" = 1, "shares", -"shares") as "total_shares_delta"
        --   FROM spacebox.dex_shares
        --   -- filter data early to reduce processing
        --   WHERE
        --     -- filter to pair
        --     "TokenZero" = ${denom0} AND
        --     "TokenOne" = ${denom1}
        -- ),        
        -- dex_reserves_zero AS (
        --   SELECT
        --     -- sorting
        --     "timestamp",
        --     "height",
        --     "sort_key",
        --     -- pool index
        --     "TokenZero",
        --     "TokenOne",
        --     "TickIndex" as "TickIndexZero",
        --     2 * "Fee" - "TickIndex" as "TickIndexOne",
        --     "Fee",
        --     -- reserves diff across each individual pool
        --     "Reserves" as "DexReservesZero",
        --     0 as "DexReservesOne"
        --   FROM spacebox.dex_message_event_tick_update
        --   -- filter data early to reduce processing
        --   WHERE
        --     -- filter to pair
        --     "TokenZero" = ${denom0} AND
        --     "TokenOne" = ${denom1} AND
        --     -- filter to token
        --     "TokenIn" = "TokenZero" AND
        --     -- do not include tranches
        --     empty("TrancheKey")
        -- ),
        -- dex_reserves_one AS (
        --   SELECT
        --     -- sorting
        --     "timestamp",
        --     "height",
        --     "sort_key",
        --     -- pool index
        --     "TokenZero",
        --     "TokenOne",
        --     2 * "Fee" - "TickIndex" as "TickIndexZero",
        --     "TickIndex" as "TickIndexOne",
        --     "Fee",
        --     -- reserves diff across each individual pool
        --     0 as "DexReservesZero",
        --     "Reserves" as "DexReservesOne"
        --   FROM spacebox.dex_message_event_tick_update
        --   -- filter data early to reduce processing
        --   WHERE
        --     -- filter to pair
        --     "TokenZero" = ${denom0} AND
        --     "TokenOne" = ${denom1} AND
        --     -- filter to token
        --     "TokenIn" = "TokenOne" AND
        --     -- do not include tranches
        --     empty("TrancheKey")
        -- ),
        -- dex_reserves_zero_deltas AS (
        --   SELECT
        --     -- sorting
        --     "timestamp",
        --     "height",
        --     "sort_key",
        --     -- pool index
        --     "TokenZero",
        --     "TokenOne",
        --     "TickIndex" as "TickIndexZero",
        --     2 * "Fee" - "TickIndex" as "TickIndexOne",
        --     "Fee",
        --     "ReservesDelta" as "DexReservesZeroDelta",
        --     0 as "DexReservesOneDelta"
        --   FROM dex_reserves_deltas
        --   -- filter to token
        --   WHERE "TokenIn" = "TokenZero"
        -- ),
        -- dex_reserves_one_deltas AS (
        --   SELECT
        --     -- sorting
        --     "timestamp",
        --     "height",
        --     "sort_key",
        --     -- pool index
        --     "TokenZero",
        --     "TokenOne",
        --     2 * "Fee" - "TickIndex" as "TickIndexZero",
        --     "TickIndex" as "TickIndexOne",
        --     "Fee",
        --     0 as "DexReservesZeroDelta",
        --     "ReservesDelta" as "DexReservesOneDelta"
        --   FROM dex_reserves_deltas
        --   -- filter to token
        --   WHERE "TokenIn" = "TokenOne"
        -- ),
        -- dex_reserves_deltas_union AS (
        --   SELECT * FROM dex_reserves_zero_deltas
        --   UNION ALL
        --   SELECT * FROM dex_reserves_one_deltas
        -- ),
        -- bank_balance_changes AS (
        --   SELECT
        --     "timestamp",
        --     "height",
        --     -- Reserves
        --     if("denom" = ${denom0}, "amount", 0) AS "ReservesZero",
        --     if("denom" = ${denom1}, "amount", 0) AS "ReservesOne"
        --   FROM spacebox.debs_and_creds
        --   WHERE "Receiver" = ${request.params.contract}
        -- ),
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
        ),
        grouped_vault_reserves_at_height as (
          SELECT
            "timestamp",
            "height",
            -- values
            sumIf("Balance", "TokenIn" = "TokenZero") as "BalanceZero",
            sumIf("Balance", "TokenIn" = "TokenOne") as "BalanceOne",
            sumIf("Reserves", "TokenIn" = "TokenZero") as "ReservesZero",
            sumIf("Reserves", "TokenIn" = "TokenOne") as "ReservesOne"
          FROM cumulative_all_at_height as reserves
          GROUP BY
            "timestamp",
            "height"
          ORDER BY "timestamp" ASC
        ),
        -- get a standard period time of how much the vault has per time period
        filled_amount_timeseries_of_period AS (
          SELECT
            toStartOfInterval(t."timestamp", INTERVAL ${raw(
              timePeriods.toFixed(0)
            )} ${raw(timePeriod)}) AS "timestamp",
            -- get last known reserves values within group
            argMax("BalanceZero", t."timestamp") AS "BalanceZero",
            argMax("BalanceOne", t."timestamp") AS "BalanceOne",
            argMax("ReservesZero", t."timestamp") AS "ReservesZero",
            argMax("ReservesOne", t."timestamp") AS "ReservesOne"
          FROM grouped_vault_reserves_at_height as t
          -- order by time
          GROUP BY "timestamp"
          ORDER BY "timestamp" ASC
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
        -- pre-filtering the join tables somehow is enough to hint ClickHouse to join the prices efficiently
        token_zero_prices AS (
          SELECT "pair_id", "timestamp", "price", "decimals"
          FROM spacebox.raw_slinky_prices
          WHERE "pair_id" = "quote_pair_zero"
        ),
        -- pre-aggregate prices to time periods
        grouped_token_zero_prices AS (
          SELECT
            "pair_id",
            toStartOfInterval(t."timestamp", INTERVAL ${raw(
                timePeriods.toFixed(0)
              )} ${raw(timePeriod)}) AS "timestamp",
            argMax("price", t."timestamp") AS "price",
            argMax("decimals", t."timestamp") AS "decimals"
          FROM spacebox.raw_slinky_prices as t
          -- filter to symbol and contract start time
          WHERE "pair_id" = "quote_pair_zero"
          AND t."timestamp" >= ${data.timestamp}
          GROUP BY "pair_id", "timestamp"
          ORDER BY "timestamp" ASC
        ),
        -- pre-filtering the join tables somehow is enough to hint ClickHouse to join the prices efficiently
        token_one_prices AS (
          SELECT "pair_id", "timestamp", "price", "decimals"
          FROM spacebox.raw_slinky_prices
          WHERE "pair_id" = "quote_pair_one"
        ),
        -- pre-aggregate prices to time periods
        grouped_token_one_prices AS (
          SELECT
            "pair_id",
            toStartOfInterval(t."timestamp", INTERVAL ${raw(
                timePeriods.toFixed(0)
              )} ${raw(timePeriod)}) AS "timestamp",
            argMax("price", t."timestamp") AS "price",
            argMax("decimals", t."timestamp") AS "decimals"
          FROM spacebox.raw_slinky_prices as t
          -- filter to symbol and contract start time
          WHERE "pair_id" = "quote_pair_one"
          AND t."timestamp" >= ${data.timestamp}
          GROUP BY "pair_id", "timestamp"
          ORDER BY "timestamp" ASC
        ),
        tvl_amount_timeseries AS (
          WITH
            concat(${data.token_0_symbol}, '-', ${data.token_0_quote_currency}) as "quote_pair_zero",
            concat(${data.token_1_symbol}, '-', ${data.token_1_quote_currency}) as "quote_pair_one"
          SELECT
            amounts."timestamp" as "timestamp",
            toFloat64(amounts."BalanceZero") as "BalanceZero",
            toFloat64(amounts."BalanceOne") as "BalanceOne",
            amounts."ReservesZero" as "ReservesZero",
            amounts."ReservesOne" as "ReservesOne",
            toFloat64(p0."price") * exp10(-p0."decimals") * ("ReservesZero" + "BalanceZero") as "tvl_0",
            toFloat64(p1."price") * exp10(-p1."decimals") * ("ReservesOne" + "BalanceOne") as "tvl_1"
          FROM (
            SELECT *,
              -- -- add fake columns to join the price data across
              -- -- without some specific ID rows ClickHouse will complain: "ASOF join needs at least one equi-join column"
              -- -- but the price table CTEs are already filtered to these IDs
              "quote_pair_zero",
              "quote_pair_one"
            FROM filled_amount_timeseries_of_period
          ) as amounts
          -- join to closest available price or token zero
          ASOF LEFT JOIN grouped_token_zero_prices as p0
            ON (amounts."ReservesZero" > 0 OR amounts."BalanceZero" > 0)
            AND p0."pair_id" = amounts."quote_pair_zero"
            AND p0."timestamp" <= amounts."timestamp"
          -- join to closest available price or token one
          ASOF LEFT JOIN grouped_token_one_prices as p1
            ON (amounts."ReservesOne" > 0 OR amounts."BalanceOne" > 0)
            AND p1."pair_id" = amounts."quote_pair_one"
            AND p1."timestamp" <= amounts."timestamp"
        ),
        deduplicated_tvl_amount_timeseries AS (
          SELECT *
          FROM (
            SELECT
              "timestamp",
              "tvl_0",
              "tvl_1",
              lagInFrame("tvl_0") OVER (ORDER BY timestamp ASC) AS "prev_tvl_0",
              lagInFrame("tvl_1") OVER (ORDER BY timestamp ASC) AS "prev_tvl_1"
            FROM tvl_amount_timeseries
          )
          WHERE "tvl_0" != "prev_tvl_0"
             OR "tvl_1" != "prev_tvl_1"
        )
        SELECT
          "timestamp" as "time",
            "tvl_0",
            "tvl_1"
          FROM tvl_amount_timeseries
          WHERE "tvl_0" > 0
             OR "tvl_1" > 0
          -- union all found tables with non-conflicting columns
          -- SELECT * FROM filled_amount_timeseries_of_period

        -- SELECT * FROM (
        --   SELECT
        --     "timestamp",
        --     "sort_key",
        --     "ReservesZero" AS "BankReservesZeroChange",
        --     0 AS "BankReservesOneChange"
        --   FROM bank_balance_token_zero_deltas
        --   UNION ALL
        --   SELECT
        --     "timestamp",
        --     "sort_key",
        --     0 AS "BankReservesZeroChange",
        --     "ReservesOne" AS "BankReservesOneChange"
        --   FROM bank_balance_token_one_deltas
        -- )
        -- default sort reverse chronologically
        ORDER BY "timestamp" ASC
        -- ORDER BY "sort_key" ASC
        -- cap limit to max, set default if not well defined
        -- LIMIT ${Math.min(Number(request.query.limit), MAX_ROWS) || DEFAULT_ROWS}
      `,
        abortSignal,
        {
          heartbeat: Number(sourceTableHeight.data.at(0)?.height),
          getRow: ({ time, tvl_0, tvl_1 }) => ({
            time,
            tvl_0,
            tvl_1,
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
                  row.name === 'tvl_0' ? { ...row, units: `${denom0} USD` } : row
                )
                ?.map((row) =>
                  row.name === 'tvl_1' ? { ...row, units: `${denom1} USD` } : row
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

// empty(TrancheKey) AND  TokenZero  = 'ibc/B559A80D62249C8AA07A380E2A2BEA6E5CA9A6F079C912C3A9E9B494105E4F81' AND TokenOne = 'ibc/C4CFF46FD6DE35CA4CF4CE031E643C8FDC9BA4B99AE598E9B0ED98FE3A2319F9'
