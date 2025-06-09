import sql from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import {
  hours,
  inMs,
  minutes,
  WithFillTimePeriod,
  toUnixTime,
} from '../../utils/units';
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
  apr: number;
}

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/apr/:contract',
  handler: async (request, abortSignal) => {
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
            FROM spacebox.dex_message_event_tick_state as t
            WHERE "TokenZero" = ${denom0}
              AND "TokenOne" = ${denom1}
        `,
        abortSignal,
        { cacheTime: 1 * minutes * inMs }
      ),
      getCachedResponse<{
        height: string;
        time: string;
      }>(
        sql`
            SELECT
              max(t."height") AS "height",
              argMax("timestamp", t."height") as "time"
            FROM spacebox.bank_transfer_state as t
            WHERE "address" = ${request.params.contract}
              AND "denom" IN (${denom0}, ${denom1})
        `,
        abortSignal,
        { cacheTime: 1 * minutes * inMs }
      ),
      getCachedResponse<{
        height: string;
        time: string;
      }>(
        sql`
            SELECT
              argMax("height_to", t."timestamp") as "height",
              max(t."timestamp") as "time"
            FROM spacebox.slinky_prices as t
            WHERE "id" IN (
              SELECT "id"
              FROM spacebox.slinky_pairs
              WHERE (
                "base" = ${token0.symbol} AND "quote" = ${token0.quoteCurrency}
                OR
                "base" = ${token1.symbol} AND "quote" = ${token1.quoteCurrency}
              )
            )
        `,
        abortSignal,
        { cacheTime: 1 * minutes * inMs }
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

    // ClickHouse will compare either native strings or Unix timestamps
    const unixTo = Number(request.query.to) || 0;

    // get timeseries data
    return await getCachedResponse<
      Response & { height: number; apr_percentage: number },
      Response
    >(
      sql`
        WITH
          30 as "days",
          ${contract} as "_contract_address",
          toStartOfHour(addMinutes(now(), -10)) as "time_end",
          addDays("time_end", -"days") as "time_start",
          COALESCE(
            (SELECT "height"
            FROM spacebox.raw_block_results
            WHERE "timestamp" <= "time_start"
            ORDER BY "height" DESC
            LIMIT 1),
            0
          ) as "height_start",
          COALESCE(
            (SELECT "height"
            FROM spacebox.raw_block_results
            WHERE "timestamp" <= "time_end"
            ORDER BY "height" DESC
            LIMIT 1), 0
          ) as "height_end",
          vault_config AS (
            SELECT * FROM spacebox.dex_vaults_config_state
            WHERE "contract_address" = "_contract_address"
            ORDER BY "updated_at" DESC
            LIMIT 1
          ),
          block_range AS (
            SELECT
              "timestamp",
              "height",
              1 as "match_all"
            FROM spacebox.raw_block_results
            WHERE "height" >= "height_start"
              AND "height" <= "height_end"
            ORDER BY "height" ASC
          ),
          slinky_price_ids AS (
            WITH
              (
                SELECT "id"
                FROM spacebox.slinky_pairs_state
                WHERE "base" = (SELECT "token_0_symbol" FROM vault_config)
                  AND "quote" = (SELECT "token_0_quote_currency" FROM vault_config)
                LIMIT 1
              ) as "price_id_0",
              (
                SELECT "id"
                FROM spacebox.slinky_pairs_state
                WHERE "base" = (SELECT "token_1_symbol" FROM vault_config)
                  AND "quote" = (SELECT "token_1_quote_currency" FROM vault_config)
                LIMIT 1
              ) as "price_id_1"
            SELECT "price_id_0", "price_id_1"
          ),
          slinky_prices_0 AS (
            SELECT *
            FROM spacebox.slinky_prices
            WHERE "id" = (SELECT "price_id_0" FROM slinky_price_ids)
          ),
          slinky_prices_1 AS (
            SELECT *
            FROM spacebox.slinky_prices
            WHERE "id" = (SELECT "price_id_1" FROM slinky_price_ids)
          ),
          price_0_first_row AS (
            SELECT
              "price",
              "decimals"
            FROM spacebox.slinky_prices_first_state
            WHERE "base" = (SELECT "token_0_symbol" FROM vault_config)
            LIMIT 1
          ),
          price_1_first_row AS (
            SELECT
              "price",
              "decimals"
            FROM spacebox.slinky_prices_first_state
            WHERE "base" = (SELECT "token_1_symbol" FROM vault_config)
            LIMIT 1
          ),
          -- note: start row is the row of the first dex deposit within (or before) the time frame
          --       this may be significantly later than some initial deposits
          balance_start_row AS (
            WITH
              balance_before_start_height as (
                SELECT
                  "time_start" AS "timestamp",
                  "height_start" as "height",
                  "sort_key",
                  "contract_address",
                  "intended_token_0_balance",
                  "intended_token_1_balance"
                FROM spacebox.dex_vaults_dex_balance as b
                -- filter data early to reduce processing
                WHERE "contract_address" = "_contract_address"
                  AND b."height" <= "height_start"
                -- keep original table order but descending
                ORDER BY b."height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
                LIMIT 1
              ),
              balance_after_start_height as (
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  "contract_address",
                  "intended_token_0_balance",
                  "intended_token_1_balance"
                FROM spacebox.dex_vaults_dex_balance as b
                -- filter data early to reduce processing
                WHERE "contract_address" = "_contract_address"
                  AND b."height" > "height_start"
                -- get last event of first block containing a new event
                ORDER BY b."height" ASC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
                LIMIT 1
              ),
              balance_start_row_union AS (
                -- we union before start height and after start height because balance_before_start_height may be empty
                SELECT *
                FROM balance_before_start_height
                UNION ALL
                SELECT *
                FROM balance_after_start_height
              ),
              balance_start_row_single AS (
                SELECT
                  *,
                  -- TODO: use proper high-resolution timestamp
                  "timestamp" + 1 as "timestamp",
                  (SELECT "price_id_0" FROM slinky_price_ids) as "price_id_0",
                  (SELECT "price_id_1" FROM slinky_price_ids) as "price_id_1"
                FROM balance_start_row_union
                WHERE (
                  "intended_token_0_balance" > 0 OR
                  "intended_token_1_balance" > 0
                )
                ORDER BY "sort_key" ASC
                LIMIT 1
              ),
              balance_start_row_valued AS (
                WITH
                  (SELECT "token_0_decimals" FROM vault_config) as "token_decimals_0",
                  (SELECT "token_1_decimals" FROM vault_config) as "token_decimals_1",
                  (SELECT "price" FROM price_0_first_row) as "first_price_0",
                  (SELECT "price" FROM price_1_first_row) as "first_price_1",
                  (SELECT "decimals" FROM price_0_first_row) as "first_decimals_0",
                  (SELECT "decimals" FROM price_1_first_row) as "first_decimals_1",
                  if(p0.timestamp = 0 AND "first_price_0" > 0, "first_price_0", p0."price") as "slinky_price_0",
                  if(p1.timestamp = 0 AND "first_price_1" > 0, "first_price_1", p1."price") as "slinky_price_1",
                  if(p0.timestamp = 0 AND "first_decimals_0" > 0, "first_decimals_0", p0."decimals") as "decimals_0",
                  if(p1.timestamp = 0 AND "first_decimals_1" > 0, "first_decimals_1", p1."decimals") as "decimals_1",
                  toFloat64("slinky_price_0") * exp10(-("token_decimals_0" + "decimals_0")) as "token_price_0",
                  toFloat64("slinky_price_1") * exp10(-("token_decimals_1" + "decimals_1")) as "token_price_1",
                  "token_price_0" * toFloat64(b."intended_token_0_balance") as "value_0",
                  "token_price_1" * toFloat64(b."intended_token_1_balance") as "value_1",
                  "value_0" + "value_1" as "value"
                SELECT
                  *,
                  b."height" as "height",
                  b."timestamp" as "timestamp",
                  "value" / 2 / "token_price_0" as "hold_equivalent_0",
                  "value" / 2 / "token_price_1" as "hold_equivalent_1"
                FROM balance_start_row_single as b
                -- join to closest available price of token zero
                ASOF LEFT JOIN slinky_prices_0 as p0
                  ON (b."price_id_0" = p0."id")
                  AND p0."timestamp" <= b."timestamp"
                -- join to closest available price of token one
                ASOF LEFT JOIN slinky_prices_1 as p1
                  ON (b."price_id_1" = p1."id")
                  AND p1."timestamp" <= b."timestamp"
              )
            SELECT *
            FROM balance_start_row_valued
          ),
          balance_end_row AS (
            WITH
              balance_after_end_height as (
                SELECT
                  "time_end" AS "timestamp",
                  "height_end" as "height",
                  "sort_key",
                  "contract_address",
                  "intended_token_0_balance",
                  "intended_token_1_balance"
                FROM spacebox.dex_vaults_dex_balance as b
                -- filter data early to reduce processing
                WHERE "contract_address" = "_contract_address"
                  AND b."height" > "height_end"
                -- keep original table order but descending
                ORDER BY b."height" ASC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
                LIMIT 1
              ),
              balance_before_end_height as (
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  "contract_address",
                  "intended_token_0_balance",
                  "intended_token_1_balance"
                FROM spacebox.dex_vaults_dex_balance as b
                -- filter data early to reduce processing
                WHERE "contract_address" = "_contract_address"
                  AND b."height" <= "height_end"
                -- get last event of first block containing a new event
                ORDER BY b."height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
                LIMIT 1
              ),
              balance_end_row_union AS (
                -- we union before start height and after start height because balance_before_start_height may be empty
                SELECT *
                FROM balance_after_end_height
                UNION ALL
                SELECT *
                FROM balance_before_end_height
              ),
              balance_end_row_single AS (
                SELECT
                  *,
                  -- TODO: use proper high-resolution timestamp
                  "timestamp" + 1 as "timestamp",
                  (SELECT "price_id_0" FROM slinky_price_ids) as "price_id_0",
                  (SELECT "price_id_1" FROM slinky_price_ids) as "price_id_1"
                FROM balance_end_row_union
                WHERE (
                  "intended_token_0_balance" > 0 OR
                  "intended_token_1_balance" > 0
                )
                ORDER BY "sort_key" ASC
                LIMIT 1
              )
            SELECT *
            FROM balance_end_row_single
          ),
          balance_increase_rows AS (
            WITH
              balance_transfers as (
                SELECT
                  "height",
                  "timestamp",
                  "sort_key",
                  "contract_address",
                  "hold_equivalent_0",
                  "hold_equivalent_1",
                FROM spacebox.dex_vaults_shares_valued
                WHERE "action" = 'deposit'
                  AND "contract_address" = "_contract_address"
                  AND "height" > greatest("height_start", (SELECT "height" FROM balance_start_row))
                  AND "height" <= least("height_end", (SELECT "height" FROM balance_end_row))
                ORDER BY "sort_key" ASC
              ),
              balance_union AS (
                SELECT
                  "height",
                  "timestamp",
                  "sort_key",
                  "contract_address",
                  "hold_equivalent_0",
                  "hold_equivalent_1"
                FROM balance_start_row
                UNION ALL
                SELECT
                  "height",
                  "timestamp",
                  "sort_key",
                  "contract_address",
                  "hold_equivalent_0",
                  "hold_equivalent_1"
                FROM balance_transfers
              )
              -- add high resolution timestamps and price ids
              SELECT
                "height",
                "timestamp",
                "sort_key",
                "contract_address",
                "hold_equivalent_0",
                "hold_equivalent_1"
              FROM balance_union
              ORDER BY "sort_key" ASC
          ),
          balance_decrease_rows AS (
            SELECT
              "timestamp",
              "height",
              "sort_key",
              "contract_address",
              -- calculate withdrawal value by percentage reduction of vault
              -- note: using calculated USD value may make cumulative balance negative
              "shares_out",
              "total_shares"
            FROM spacebox.dex_vaults_shares_valued
            WHERE "action" = 'withdrawal'
              AND "contract_address" = "_contract_address"
              AND "height" > greatest("height_start", (SELECT "height" FROM balance_start_row))
              AND "height" <= least("height_end", (SELECT "height" FROM balance_end_row))
            ORDER BY "sort_key" ASC
          ),
          balance_hold_amount AS (
            WITH
              hold_adjustments_union AS (
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  "contract_address",
                  "hold_equivalent_0" as "hold_amount_increase_0",
                  "hold_equivalent_1" as "hold_amount_increase_1",
                  0 as "share_fraction_reduction"
                FROM balance_increase_rows
                UNION ALL
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  "contract_address",
                  0 as "hold_amount_increase_0",
                  0 as "hold_amount_increase_1",
                  toFloat64("shares_out" / ("shares_out" + "total_shares")) as "share_fraction_reduction"
                FROM balance_decrease_rows
              ),
              -- ensure there are no duplicate events for each event index before SUM
              hold_adjustments_by_event AS (
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  anyLast("contract_address") as "contract_address",
                  anyLast("hold_amount_increase_0") as "hold_amount_increase_0",
                  anyLast("hold_amount_increase_1") as "hold_amount_increase_1",
                  anyLast("share_fraction_reduction") as "share_fraction_reduction"
                FROM hold_adjustments_union
                GROUP BY "sort_key", "height", "timestamp"
                ORDER BY "sort_key" ASC
              ),
              hold_amount_by_event AS (
                WITH
                  /* ---- 1. build the running product (P_i) ---- */
                  prod AS (
                    SELECT
                      "timestamp",
                      "height",
                      "sort_key",
                      "contract_address",
                      "hold_amount_increase_0",
                      "hold_amount_increase_1",

                      /* prefix-product P_i  =  exp( Σ log(mult) ) */
                      exp(
                        sum( log( toFloat64(1 - "share_fraction_reduction") ) ) OVER (
                          ORDER BY "sort_key"
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                        )
                      ) AS "P_i"
                    FROM hold_adjustments_by_event
                  ),
                  /* ---- 2. derive scaled increases ---- */
                  calc AS (
                    SELECT
                      "timestamp",
                      "height",
                      "sort_key",
                      "contract_address",
                      "P_i",
                      /* scaled add_k / P */
                      toFloat64("hold_amount_increase_0") / "P_i" AS "scaled_hold_amount_increase_0",
                      toFloat64("hold_amount_increase_1") / "P_i" AS "scaled_hold_amount_increase_1"
                    FROM prod
                  )
                  /* ---- 3. get running sum, final total ---- */
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  "contract_address",
                  /* running sum of scaled_add = Σ add_k / P */
                  /* final cumulative total is prefix-product * running-sum */
                  "P_i" * sum("scaled_hold_amount_increase_0") OVER cumulative_events AS "hold_amount_0",
                  "P_i" * sum("scaled_hold_amount_increase_1") OVER cumulative_events AS "hold_amount_1"
                FROM calc
                WINDOW cumulative_events AS (
                  ORDER BY "sort_key" ASC
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                )
                ORDER BY "sort_key"
              )
              -- get the last value at each height
              SELECT
                argMax("contract_address", "sort_key") as "contract_address",
                argMax("hold_amount_0", "sort_key") as "hold_amount_0",
                argMax("hold_amount_1", "sort_key") as "hold_amount_1"
              FROM hold_amount_by_event
          ),
          vault_end_state AS (
            WITH
              (SELECT "token_0_decimals" FROM vault_config) as "token_decimals_0",
              (SELECT "token_1_decimals" FROM vault_config) as "token_decimals_1",
              (SELECT "price" FROM price_0_first_row) as "first_price_0",
              (SELECT "price" FROM price_1_first_row) as "first_price_1",
              (SELECT "decimals" FROM price_0_first_row) as "first_decimals_0",
              (SELECT "decimals" FROM price_1_first_row) as "first_decimals_1",
              if(p0.timestamp = 0 AND "first_price_0" > 0, "first_price_0", p0."price") as "slinky_price_0",
              if(p1.timestamp = 0 AND "first_price_1" > 0, "first_price_1", p1."price") as "slinky_price_1",
              if(p0.timestamp = 0 AND "first_decimals_0" > 0, "first_decimals_0", p0."decimals") as "decimals_0",
              if(p1.timestamp = 0 AND "first_decimals_1" > 0, "first_decimals_1", p1."decimals") as "decimals_1",
              toFloat64("slinky_price_0") * exp10(-("token_decimals_0" + "decimals_0")) as "token_price_0",
              toFloat64("slinky_price_1") * exp10(-("token_decimals_1" + "decimals_1")) as "token_price_1",
              "token_price_0" * toFloat64(h."hold_amount_0") as "hold_value_0",
              "token_price_1" * toFloat64(h."hold_amount_1") as "hold_value_1",
              COALESCE("hold_value_0" + "hold_value_1", 0) as "hold_value",
              "token_price_0" * toFloat64(b."intended_token_0_balance") as "vault_value_0",
              "token_price_1" * toFloat64(b."intended_token_1_balance") as "vault_value_1",
              COALESCE("vault_value_0" + "vault_value_1", 0) as "vault_value"
            SELECT
              b."timestamp" as "timestamp",
              b."height" as "height",
              b."contract_address" as "contract_address",
              h."hold_amount_1" as "hold_amount_1",
              h."hold_amount_0" as "hold_amount_0",
              b."intended_token_0_balance" as "vault_amount_0",
              b."intended_token_1_balance" as "vault_amount_1",
              "hold_value",
              "vault_value"
            FROM balance_end_row as b
            JOIN balance_hold_amount as h
            ON (b."contract_address" = h."contract_address")
            -- join to closest available price of token zero
            ASOF LEFT JOIN slinky_prices_0 as p0
              ON (b."price_id_0" = p0."id")
              AND p0."timestamp" <= b."timestamp"
            -- join to closest available price of token one
            ASOF LEFT JOIN slinky_prices_1 as p1
              ON (b."price_id_1" = p1."id")
              AND p1."timestamp" <= b."timestamp"
          )
          SELECT
            "contract_address",
            ("vault_value" - "hold_value") / "hold_value" / "days" * 365 as "apr"
          FROM vault_end_state
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        getRow: ({ time, apr }) => ({ time, apr }),
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
        staleTimeMax: 1 * hours * inMs,
        staleTimeMin: 0.1 * hours * inMs,
        cacheVersion: Number(currentHeight?.data.at(0)?.height) || 0,
      }
    );
  },
};
