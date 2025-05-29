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
          (
            SELECT "height"
            FROM spacebox.raw_block_results
            WHERE "timestamp" <= "time_start"
            ORDER BY "height" DESC
            LIMIT 1
          ) as "height_start",
          (
            SELECT "height"
            FROM spacebox.raw_block_results
            WHERE "timestamp" <= "time_end"
            ORDER BY "height" DESC
            LIMIT 1
          ) as "height_end",
          vaults AS (${selectVaultConfigs}),
          vault_config AS (
            SELECT * FROM vaults
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
          balance_start_row AS (
            WITH
              balace_before_start_height as (
                SELECT
                  "time_start" AS "timestamp",
                  "height_start" as "height",
                  "sort_key",
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
              balace_after_start_height as (
                SELECT
                  "time_start" AS "timestamp",
                  "height_start" as "height",
                  "sort_key",
                  "intended_token_0_balance",
                  "intended_token_1_balance"
                FROM spacebox.dex_vaults_dex_balance as b
                -- filter data early to reduce processing
                WHERE "contract_address" = "_contract_address"
                  AND b."height" > "height_start"
                -- keep original table order but descending
                ORDER BY b."height" ASC, "block_part_index" ASC, "tx_index" ASC, "event_index" ASC
                LIMIT 1
              )
            -- we union before start height and after start height because balace_before_start_height may be empty
            SELECT *, "sort_key", 1 as "match_all"
            FROM balace_before_start_height
            UNION ALL
            SELECT *, "sort_key", 1 as "match_all"
            FROM balace_after_start_height
            ORDER BY "sort_key" ASC
            LIMIT 1
          ),
          balance_end_row AS (
            SELECT
              "time_end" AS "timestamp",
              "height_end" as "height",
              "sort_key",
              "intended_token_0_balance",
              "intended_token_1_balance",
              1 as "match_all"
            FROM spacebox.dex_vaults_dex_balance as b
            -- filter data early to reduce processing
            WHERE "contract_address" = "_contract_address"
              AND b."height" <= "height_end"
            -- keep original table order but descending
            ORDER BY b."height" DESC, "block_part_index" DESC, "tx_index" DESC, "event_index" DESC
            LIMIT 1
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
            WHERE "base" = (SELECT "token_0_symbol" FROM vault_config)
              AND "quote" = 'USD'
            LIMIT 1
          ) as "price_id_0",
          (
            SELECT "id"
            FROM price_ids
            WHERE "base" = (SELECT "token_1_symbol" FROM vault_config)
              AND "quote" = 'USD'
            LIMIT 1
          ) as "price_id_1",
          balance_increase_rows AS (
            WITH
              balance_transfers as (
                SELECT
                  "height",
                  "sort_key",
                  "token_0_deposited",
                  "token_1_deposited"
                FROM spacebox.dex_vaults_shares
                WHERE "action" = 'deposit'
                  AND "contract_address" = "_contract_address"
                  AND "height" >= "height_start"
                  AND "height" <= "height_end"
                ORDER BY "sort_key" ASC
              ),
              balance_union AS (
                SELECT
                  "height",
                  "sort_key",
                  "intended_token_0_balance" as "token_0_deposited",
                  "intended_token_1_balance" as "token_1_deposited"
                FROM balance_start_row
                UNION ALL
                SELECT
                  "height",
                  "sort_key",
                  -- calculate deposit value by amount increased
                  "token_0_deposited",
                  "token_1_deposited"
                FROM balance_transfers
              )
              -- add high resolution timestamps and price ids
              SELECT
                r."timestamp" as "timestamp",
                b."height" as "height",
                b."sort_key" as "sort_key",
                b."token_0_deposited" as "token_0_deposited",
                b."token_1_deposited" as "token_1_deposited",
                "price_id_0",
                "price_id_1"
              FROM balance_union as b
              JOIN block_range as r
              ON (b."height" = r."height")
              ORDER BY "sort_key" ASC
          ),
          balance_decrease_rows AS (
            SELECT
              r."timestamp" as "timestamp",
              "height",
              "sort_key",
              -- calculate withdrawal value by percentage reduction of vault
              -- note: using calculated USD value may make cumulative balance negative
              "shares_out",
              "total_shares"
            FROM spacebox.dex_vaults_shares as s
            JOIN block_range as r
            ON (s."height" = r."height")
            WHERE "action" = 'withdrawal'
              AND "contract_address" = "_contract_address"
              AND "height" >= "height_start"
              AND "height" <= "height_end"
            ORDER BY "sort_key" ASC
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
          balance_hold_amount AS (
            WITH
              hold_amount_increases AS (
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
                  "token_price_0" * toFloat64(b."token_0_deposited") as "value_0",
                  "token_price_1" * toFloat64(b."token_1_deposited") as "value_1",
                  "value_0" + "value_1" as "value"
                SELECT
                  b."timestamp" as "timestamp",
                  b."height" as "height",
                  "value" / 2 / "token_price_0" as "hold_amount_increase_0",
                  "value" / 2 / "token_price_1" as "hold_amount_increase_1",
                  b."sort_key"
                FROM balance_increase_rows as b
                -- join to closest available price of token zero
                ASOF LEFT JOIN slinky_prices_0 as p0
                  ON (b."price_id_0" = p0."id")
                  AND p0."timestamp" <= b."timestamp"
                -- join to closest available price of token one
                ASOF LEFT JOIN slinky_prices_1 as p1
                  ON (b."price_id_1" = p1."id")
                  AND p1."timestamp" <= b."timestamp"
              ),
              hold_amount_decreases AS (
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  toFloat64("shares_out" / ("shares_out" + "total_shares")) as "share_fraction_reduction"
                FROM balance_decrease_rows
              ),
              hold_adjustments_union AS (
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  "hold_amount_increase_0",
                  "hold_amount_increase_1",
                  0 as "share_fraction_reduction"
                FROM hold_amount_increases
                UNION ALL
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  0 as "hold_amount_increase_0",
                  0 as "hold_amount_increase_1",
                  "share_fraction_reduction"
                FROM hold_amount_decreases
              ),
              -- ensure there are no duplicate events for each event index before SUM
              hold_adjustments_by_event AS (
                SELECT
                  "timestamp",
                  "height",
                  "sort_key",
                  anyLast("hold_amount_increase_0") as "hold_amount_increase_0",
                  anyLast("hold_amount_increase_1") as "hold_amount_increase_1",
                  anyLast("share_fraction_reduction") as "share_fraction_reduction"
                FROM hold_adjustments_union
                GROUP BY "height", "timestamp", "sort_key"
              ),
              hold_amount_by_event AS (
                WITH
                  /* ---- 1. build the running product (P_i) ---- */
                  prod AS (
                    SELECT
                      "timestamp",
                      "height",
                      "sort_key",
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
                argMax("hold_amount_0", "sort_key") as "hold_amount_0",
                argMax("hold_amount_1", "sort_key") as "hold_amount_1",
                "price_id_0",
                "price_id_1",
                1 as "match_all"
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
              "token_price_0" * toFloat64(b."vault_amount_0") as "vault_value_0",
              "token_price_1" * toFloat64(b."vault_amount_1") as "vault_value_1",
              COALESCE("vault_value_0" + "vault_value_1", 0) as "vault_value"
            SELECT
              b."timestamp" as "timestamp",
              b."height" as "height",
              h."hold_amount_0" as "hold_amount_0",
              h."hold_amount_1" as "hold_amount_1",
              b."vault_amount_0" as "vault_amount_0",
              b."vault_amount_1" as "vault_amount_1",
              "hold_value",
              "vault_value"
            FROM (
              SELECT
                "timestamp",
                "height",
                "intended_token_0_balance" as "vault_amount_0",
                "intended_token_1_balance" as "vault_amount_1"
              FROM balance_end_row
            ) as b
            JOIN  (
              SELECT
                "hold_amount_0",
                "hold_amount_1",
                "price_id_0",
                "price_id_1"
              FROM balance_hold_amount
            ) as h
            ON 1 = 1
            -- join to closest available price of token zero
            ASOF LEFT JOIN slinky_prices_0 as p0
              ON (h."price_id_0" = p0."id")
              AND p0."timestamp" <= b."timestamp"
            -- join to closest available price of token one
            ASOF LEFT JOIN slinky_prices_1 as p1
              ON (h."price_id_1" = p1."id")
              AND p1."timestamp" <= b."timestamp"
          )
          SELECT ("vault_value" - "hold_value") / "hold_value" / "days" * 365 as "apr"
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
        cacheVersion: allUpdateHeights
          .map((res) => Number(res.data.at(0)?.height) || 0)
          .reduce((acc, v) => acc + v, 0),
      }
    );
  },
};
