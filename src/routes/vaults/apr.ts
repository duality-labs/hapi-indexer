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
import { bankReservesAtHeightTimeseries } from '../../common-table-expressions/bankReservesTimeseries';
import {
  selectVaultConfigs,
  VaultResponse,
} from '../../common-table-expressions/vaultConfigs';
import dexVaultReservesTimeseries from '../../common-table-expressions/dexVaultReserves';

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
    const token0 = {
      denom: data.token_0_denom,
      decimals: data.token_0_decimals,
      maxBlocksStale: data.token_0_max_blocks_stale,
      symbol: data.token_0_symbol,
      quoteCurrency: data.token_0_quote_currency,
    };
    const token1 = {
      denom: data.token_1_denom,
      decimals: data.token_1_decimals,
      maxBlocksStale: data.token_1_max_blocks_stale,
      symbol: data.token_1_symbol,
      quoteCurrency: data.token_1_quote_currency,
    };

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
              AND "denom" IN (${denom0}, ${denom1})
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
        -- define start and end times of the measurement
        -- WITH
        -- price_ids AS (
        --   WITH price_ids_by_height AS (
        --     SELECT
        --       "base",
        --       "quote",
        --       "id",
        --       maxMerge("height_to") as "height"
        --     FROM spacebox.slinky_pairs
        --     GROUP BY "base", "quote", "id"
        --   )
        --   SELECT
        --     "base",
        --     "quote",
        --     argMax("id", "height") as "id"
        --   FROM price_ids_by_height
        --   GROUP BY "base", "quote"
        -- ),
        -- (
        --   SELECT "id"
        --   FROM price_ids
        --   WHERE "base" = 'USDC'
        --     AND "quote" = 'USD'
        --   LIMIT 1
        -- ) as "price_id_0",
        -- (
        --   SELECT "id"
        --   FROM price_ids
        --   WHERE "base" = 'NTRN'
        --     AND "quote" = 'USD'
        --   LIMIT 1
        -- ) as "price_id_1",
        -- toStartOfHour( addMinutes( now(), -10 ) ) as "time_end",
        -- addDays("time_end", -30) as "time_start",
        -- -- define CTEs
        -- vault_reserves AS (
        --   SELECT
        --     -- sorting
        --     "timestamp",
        --     "height",
        --     -- values
        --     -- note: fix difference between intended and actual balance later
        --     --       intended balance does not account for "swap on deposit"
        --     --       or failed deposit events: the intended balance will be 100%
        --     --       of the vault's available tokens, but actual value may differ
        --     "intended_token_0_balance" as "balance_0",
        --     "intended_token_1_balance" as "balance_1"
        --   FROM spacebox.dex_vaults_dex_balance_by_height
        --   -- filter data early to reduce processing
        --   WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
        --   ORDER BY "contract_address" ASC, "timestamp" DESC
        -- ),
        -- balance_basis AS (
        --   SELECT *
        --   FROM vault_reserves
        --   WHERE "timestamp" < "time_end"
        --   LIMIT 1
        -- )
        -- SELECT * FROM balance_basis
        -- define start and end times of the measurement
        WITH
        toStartOfHour(addMinutes(now(), -10)) as "time_end",
        addDays("time_end", -30) as "time_start",
        -- (
        --   SELECT "timestamp"
        --   FROM spacebox.dex_vaults_dex_balance
        --   -- filter data early to reduce processing
        --   WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
        --     AND "timestamp" < "time_start"
        --   -- keep original table order but descending
        --   ORDER BY "height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
        --   LIMIT 1
        -- ) as "time_balance_start",
        balance_start_row AS (
          SELECT
            "time_start" AS "timestamp",
            "height",
            "intended_token_0_balance",
            "intended_token_1_balance"
          FROM spacebox.dex_vaults_dex_balance as b
          -- filter data early to reduce processing
          WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
            AND b."timestamp" <= "time_start"
          -- keep original table order but descending
          ORDER BY "height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
          LIMIT 1
        ),
        balance_end_row AS (
          SELECT
            "time_end" AS "timestamp",
            "height",
            "intended_token_0_balance",
            "intended_token_1_balance"
          FROM spacebox.dex_vaults_dex_balance as b
          -- filter data early to reduce processing
          WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
            AND b."timestamp" <= "time_end"
          -- keep original table order but descending
          ORDER BY "height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
          LIMIT 1
        ),
        -- somehow grouping here uses 50% of time and 20% of memory than the projection
        balance_by_height AS (
          SELECT
            "timestamp",
            "height",
            argMax("intended_token_0_balance", "sort_key") as "intended_token_0_balance",
            argMax("intended_token_1_balance", "sort_key") as "intended_token_1_balance"
          FROM spacebox.dex_vaults_dex_balance
          WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
            AND "timestamp" > "time_start"
            AND "timestamp" < "time_end"
          GROUP BY "height", "timestamp"
          ORDER BY "timestamp" ASC
        ),
        price_ids AS (
          WITH price_ids_by_height AS (
            SELECT
              "base",
              "quote",
              "id",
              maxMerge("height_to") as "height"
            FROM spacebox.slinky_pairs
            GROUP BY "base", "quote", "id"
          )
          SELECT
            "base",
            "quote",
            argMax("id", "height") as "id"
          FROM price_ids_by_height
          GROUP BY "base", "quote"
        ),
        (
          SELECT "id"
          FROM price_ids
          WHERE "base" = 'USDC'
            AND "quote" = 'USD'
          LIMIT 1
        ) as "price_id_0",
        (
          SELECT "id"
          FROM price_ids
          WHERE "base" = 'NTRN'
            AND "quote" = 'USD'
          LIMIT 1
        ) as "price_id_1",
        balance_by_height_union AS (
          SELECT *, "price_id_0", "price_id_1"
          FROM (
            SELECT * FROM balance_start_row
            UNION ALL
            SELECT * FROM balance_by_height
            UNION ALL
            SELECT * FROM balance_end_row
          )
          ORDER BY "timestamp" ASC
        ),
        slinky_prices_0 AS (
          SELECT *
          FROM spacebox.slinky_prices
          WHERE "id" = (
            SELECT "id"
            FROM price_ids
            WHERE "base" = 'USDC'
              AND "quote" = 'USD'
            LIMIT 1
          )
        ),
        slinky_prices_1 AS (
          SELECT *
          FROM spacebox.slinky_prices
          WHERE "id" = (
            SELECT "id"
            FROM price_ids
            WHERE "base" = 'NTRN'
              AND "quote" = 'USD'
            LIMIT 1
          )
        ),
        price_0_first_row AS (
          SELECT
            "price",
            "decimals"
          FROM slinky_prices_0
          ORDER BY "id" ASC, "timestamp" ASC
          LIMIT 1
        ),
        price_1_first_row AS (
          SELECT
            "price",
            "decimals"
          FROM slinky_prices_1
          ORDER BY "id" ASC, "timestamp" ASC
          LIMIT 1
        ),
        tvl_timeseries AS (
          WITH
            (SELECT "price" FROM price_0_first_row) as "first_price_0",
            (SELECT "decimals" FROM price_0_first_row) as "first_decimals_0",
            (SELECT "price" FROM price_1_first_row) as "first_price_1",
            (SELECT "decimals" FROM price_1_first_row) as "first_decimals_1"
          SELECT
            b."timestamp" as "timestamp",
            b."height" as "height",
            b."intended_token_0_balance" as "balance_0",
            b."intended_token_1_balance" as "balance_1",
            COALESCE(p0."price", "first_price_0") as "price_0",
            COALESCE(p0."decimals", "first_decimals_0") as "decimals_0",
            COALESCE(p1."price", "first_price_1") as "price_1",
            COALESCE(p1."decimals", "first_decimals_1") as "decimals_1",
            toFloat64("price_0") * exp10(-(6 + "decimals_0")) * toFloat64("balance_0") as "tvl_0",
            toFloat64("price_1") * exp10(-(6 + "decimals_1")) * toFloat64("balance_1") as "tvl_1",
            "tvl_0" + "tvl_1" as "tvl"
          FROM balance_by_height_union as b
          -- join to closest available price of token zero
          ASOF LEFT JOIN slinky_prices_0 as p0
            ON (b."price_id_0" = p0."id")
            AND p0."timestamp" <= b."timestamp"
          -- join to closest available price of token one
          ASOF LEFT JOIN slinky_prices_1 as p1
            ON (b."price_id_1" = p1."id")
            AND p1."timestamp" <= b."timestamp"
        ),
        tvl_valuation_periods AS (
          WITH
            tvl_timeseries_with_markers AS (
              SELECT
                *,
                lagInFrame("timestamp", 1, "time_start") OVER chronologically as "previous_timestamp",
                lagInFrame("tvl", 1, NULL) OVER chronologically as "previous_tvl",
                -- use 32 bit to allow enough repeated rows for heights within 30 days
                toUInt32("tvl" != "previous_tvl") AS "is_new_run"
              FROM tvl_timeseries
              WINDOW chronologically AS (
                ORDER BY "timestamp" ASC
                ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
              )
            ),
            tvl_timeseries_with_segment_id AS (
              SELECT
                *,
                sum("is_new_run") OVER chronologically as "segment_id"
              FROM tvl_timeseries_with_markers
              WINDOW chronologically AS (
                ORDER BY "timestamp" ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              )
            ),
            tvl_timeseries_segmented AS (
              SELECT
                -- argMin(t."previous_timestamp", t."timestamp") as "previous_timestamp",
                argMin(t."timestamp", t."timestamp") as "timestamp",
                argMin(t."previous_tvl", t."timestamp") as "previous_tvl",
                argMin(t."tvl", t."timestamp") as "tvl"
              FROM tvl_timeseries_with_segment_id as t
              GROUP BY "segment_id"
            )
          SELECT
            lagInFrame("timestamp", 1, "time_start") OVER chronologically as "previous_timestamp",
            *
          FROM tvl_timeseries_segmented
          WINDOW chronologically AS (
            ORDER BY "timestamp" ASC
            ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
          )
        ),
        apr AS (
          SELECT
            "timestamp",
            "tvl",
            dateDiff('second', "previous_timestamp", "timestamp") as "seconds_diff",
            if ("previous_tvl" IS NOT NULL, ("tvl" - "previous_tvl") / "previous_tvl", 0) as "t"
          FROM tvl_valuation_periods
          -- SELECT sum(
          --   dateDiff('second', "timestamp", "previous_timestamp") * ("tvl" - "previous_tvl") / "previous_tvl"
          -- ) as apr
        )
        -- SELECT count(*) FROM tvl_valuation_periods
        SELECT * FROM apr LIMIT 3
        -- SELECT * FROM tvl_valuation_periods ORDER BY "timestamp" ASC LIMIT 3
        SETTINGS join_use_nulls=1
        ,
        tvl_periods AS (
          WITH
            leadInFrame("timestamp", 1, "time_end") OVER (
              ORDER BY "timestamp" ASC
            ) as "next_timestamp"
          SELECT
            *,
            dateDiff('ms', "timestamp", "next_timestamp") as "milliseconds_duration"
          FROM balance_with_prices
          WINDOW chronologically AS (
            ORDER BY "timestamp" ASC
            ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING
          )
        )
        -- SELECT avg("tvl") FROM tvl_periods
        SELECT * FROM tvl_periods ORDER BY "timestamp" ASC LIMIT 3
        SETTINGS join_use_nulls=1
        -- dex_vaults_dex_balance_by_height AS (
        --   SELECT
        --     "timestamp",
        --     "height",
        --     "intended_token_0_balance",
        --     "intended_token_1_balance"
        --   FROM spacebox.dex_vaults_dex_balance_by_height
        --   WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
        --     AND "timestamp" >= "time_balance_start"
        --     AND "timestamp" < "time_end"
        --   ORDER BY "timestamp" DESC
        -- )
        -- SELECT count(*) FROM dex_vaults_dex_balance_by_height
        ,
        vault_reserves AS (
          SELECT
            -- sorting
            "timestamp",
            "height",
            -- values
            -- note: fix difference between intended and actual balance later
            --       intended balance does not account for "swap on deposit"
            --       or failed deposit events: the intended balance will be 100%
            --       of the vault's available tokens, but actual value may differ
            "intended_token_0_balance" as "balance_0",
            "intended_token_1_balance" as "balance_1"
          FROM spacebox.dex_vaults_dex_balance_by_height
          -- filter data early to reduce processing
          WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
        ),
        -- get balance basis from original table: actually faster, doesn't need to scan projection
        balance_basis AS (
          SELECT
            -- sorting
            "timestamp",
            "height",
            -- values
            -- note: fix difference between intended and actual balance later
            --       intended balance does not account for "swap on deposit"
            --       or failed deposit events: the intended balance will be 100%
            --       of the vault's available tokens, but actual value may differ
            "intended_token_0_balance" as "balance_0",
            "intended_token_1_balance" as "balance_1"
          FROM spacebox.dex_vaults_dex_balance
          -- filter data early to reduce processing
          WHERE "contract_address" = 'neutron16jdl03kz2ggrdm90lu3t4hdqj3tpc808r06nrcpnf0xun9wuqaws7qw42x'
          AND "timestamp" < "time_end"
          -- keep original table order but descending
          ORDER BY "height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
          LIMIT 1
        )
        SELECT * FROM balance_basis
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
          FROM (${bankReservesAtHeightTimeseries(
            contract,
            denom0,
            denom1
          )}) as t
          -- reduce grouping work by filtering to period first
          WHERE 1 = 1
            ${
              // ensure bank balances are read all the way from start of contract
              timeContractStart
                ? sql`AND t."timestamp" >= toStartOfInterval(
                    toDateTime(${timeContractStart}),
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
        ),
        cumulative_vault_reserves AS (${dexVaultReservesTimeseries(
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
            -- get the last row of the matching height
            "Reserves"
          FROM (
            SELECT *,
              ROW_NUMBER() OVER (
                -- get all rows matching a certain pool and height
                PARTITION BY "height", "TokenZero", "TokenOne", "TokenIn"
                ORDER BY "sort_key" DESC
              ) AS "row_order"
            FROM cumulative_vault_reserves as t
            -- reduce grouping work by filtering to period first
            WHERE 1 = 1
              ${
                // ensure bank balances are read all the way from start of contract
                timeContractStart
                  ? sql`AND t."timestamp" >= toStartOfInterval(
                      toDateTime(${timeContractStart}),
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
          )
          WHERE "row_order" = 1
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
            -- protect against possible negative balances due to possible missing rows
            greatest(argMax("BalanceZero", t."timestamp"), 0) AS "BalanceZero",
            greatest(argMax("BalanceOne", t."timestamp"), 0) AS "BalanceOne",
            argMax("ReservesZero", t."timestamp") AS "ReservesZero",
            argMax("ReservesOne", t."timestamp") AS "ReservesOne"
          FROM grouped_vault_reserves_at_height as t
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
            "timestamp",
            "price",
            "decimals"
          FROM spacebox.raw_slinky_prices as t
          -- filter to symbol and contract start time
          WHERE ("pair_id" = "quote_pair_zero" OR "pair_id" = "quote_pair_one")
          ${
            timeContractStart
              ? sql`AND t."timestamp" >= toStartOfInterval(
                  toDateTime(${timeContractStart}),
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
          -- GROUP BY "pair_id", "timestamp"
          -- ORDER BY "timestamp" ASC
        ),
        tvl_amount_timeseries AS (
          -- note: use intended deposits fix instead of actual on chain reserves
          WITH
            amounts."ReservesZero" > 0 OR amounts."ReservesOne" > 0 as "has_intended_deposits"
          SELECT
            amounts."timestamp" as "timestamp",
            amounts."height" as "height",
            toFloat64(if("has_intended_deposits" = 1, 0, amounts."BalanceZero")) as "BalanceZero",
            toFloat64(if("has_intended_deposits" = 1, 0, amounts."BalanceOne")) as "BalanceOne",
            toFloat64(amounts."ReservesZero") as "ReservesZero",
            toFloat64(amounts."ReservesOne") as "ReservesOne",
            toFloat64(p0."price") * exp10(-(${
              token0.decimals
            } + p0."decimals")) as "p_0",
            toFloat64(p1."price") * exp10(-(${
              token1.decimals
            } + p1."decimals")) as "p_1",
            toFloat64(p0."price") * exp10(-(${
              token0.decimals
            } + p0."decimals")) * ("ReservesZero" + "BalanceZero") as "tvl_0",
            toFloat64(p1."price") * exp10(-(${
              token1.decimals
            } + p1."decimals")) * ("ReservesOne" + "BalanceOne") as "tvl_1"
          FROM (
            -- filter to selected time here
            -- unfortunately required past balances to know current values
            -- and cannot be filtered until thihs step
            SELECT *
            FROM filled_amount_timeseries_of_period as t
            WHERE 1 = 1
            ${
              timePrevious || unixFrom
                ? sql`AND t."timestamp" >= toStartOfInterval(
                    toDateTime(${timePrevious || unixFrom}),
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
          ) as amounts
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
          *
        FROM tvl_amount_timeseries
        -- default sort reverse chronologically
        ORDER BY "time" DESC
        -- cap limit to max, set default if not well defined
        LIMIT ${Math.min(Number(request.query.limit), MAX_ROWS) || DEFAULT_ROWS}
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        getRow: ({ time, tvl_0, tvl_1, ...rest }) =>
          time.startsWith('2025-04-28')
            ? { time, tvl_0, tvl_1, tvl: tvl_0 + tvl_1, ...rest }
            : [],
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
        cacheVersion: allUpdateHeights
          .map((res) => Number(res.data.at(0)?.height) || 0)
          .reduce((acc, v) => acc + v, 0),
      }
    );
  },
};
