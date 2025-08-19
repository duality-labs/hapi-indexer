import sql from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import {
  route as tvlRoute,
  Request as TvlRequest,
  Response as TvlResponse,
} from './tvl';
import {
  route as aprRoute,
  Request as AprRequest,
  Response as AprResponse,
} from './apr';
import {
  route as sharesRoute,
  Request as SharesRequest,
  Response as SharesResponse,
} from './shares';
import {
  route as volumeRoute,
  Request as VolumeRequest,
  Response as VolumeResponse,
} from './swap-volume';
import { GetData } from '../../utils/response';
import { endTime, getEndTimeCacheConfig } from './_common';
import dexVaultReturnTimeseries from '../../common-table-expressions/dexVaultReturnTimeseries';

interface Request {
  params: { contract: string };
  query: {
    limit?: string;
    with?: string;
  };
}
interface Response {
  time: string;
  created_at: string;
  updated_at: string;
  contract_address: string;
  whitelist: string;
  token_0_denom: string;
  token_0_decimals: number;
  token_0_symbol: string;
  token_0_quote_currency: string;
  token_0_max_blocks_old: string;
  token_1_denom: string;
  token_1_decimals: number;
  token_1_symbol: string;
  token_1_quote_currency: string;
  token_1_max_blocks_old: string;
  token_order: string[];
  pool_id: string;
  deposit_cap: string;
  oracle_contract: string;
  imbalance: string;
  fee_tier_config: string;
  timestamp_stale: string;
  paused: false;
  denom: string;
  amount_0: string;
  amount_1: string;
  tvl_0: number;
  tvl_1: number;
  tvl_prev_1d_0: number;
  tvl_prev_1d_1: number;
  apr_30d: number;
  apy_vault_30d: number;
  apy_hold_30d: number;
  volume_1d: number;
  volume_prev_1d: number;
  volume_30d: number;
}
const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

export const route: Route<
  Request,
  Response,
  {
    tvl?: GetData<TvlRequest, TvlResponse>;
    shares?: GetData<SharesRequest, SharesResponse>;
  }
> = {
  method: 'get',
  path: '/vaults',
  handler: async (request, abortSignal, previousResponse) => {
    // cache to specific end time
    const cacheConfig = await getEndTimeCacheConfig(abortSignal);

    const sourceTableHeight = await getCachedResponse<{
      height: string;
      time: string;
    }>(
      sql`
        SELECT
          max(b."height") AS "height",
          argMax("timestamp", b."height") AS "time"
        FROM spacebox."dex_vaults_dex_balance" as b
        WHERE "timestamp" <= ${endTime}
      `,
      abortSignal,
      cacheConfig
    );

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        WITH
          30 as "period_in_days",
          365 as "days_in_year",
          time_period as (
            SELECT
              toDateTime64(addDays("time_end", -"period_in_days"), 9) as "time_start",
              toDateTime64(${endTime}, 9) as "time_end"
          ),
          vault_config as (
            SELECT v.*
            FROM spacebox.dex_vaults_config_state as v
            ANY LEFT JOIN spacebox.price_by_vault_denom_first_state as p
              ON (v."contract_address" = p."contract_address")
          ),
          tvl AS (
            WITH balance AS (
              WITH (SELECT "time_end" FROM time_period) as "time_end"
              SELECT
                "contract_address",
                argMax("token_0_balance_before_deposit", "height") as "token_0_amount",
                argMax("token_1_balance_before_deposit", "height") as "token_1_amount",
                argMax("token_0_price", "height") as "token_0_price",
                argMax("token_1_price", "height") as "token_1_price"
              FROM spacebox.dex_vaults_dex_balance as b
              WHERE "action" = 'dex_deposit'
                AND "timestamp" < "time_end"
              GROUP BY "contract_address"
            )
            SELECT
              "contract_address",
              "token_0_amount",
              "token_1_amount",
              toFloat64("token_0_amount") * "token_0_price" as "token_0_value",
              toFloat64("token_1_amount") * "token_1_price" as "token_1_value"
            FROM balance
          ),
          tvl_prev_1d AS (
            WITH balance AS (
              WITH (SELECT "time_end" FROM time_period) as "time_end"
              SELECT
                "contract_address",
                argMax("token_0_balance_before_deposit", "height") as "token_0_amount",
                argMax("token_1_balance_before_deposit", "height") as "token_1_amount",
                argMax("token_0_price", "height") as "token_0_price",
                argMax("token_1_price", "height") as "token_1_price"
              FROM spacebox.dex_vaults_dex_balance as b
              WHERE "action" = 'dex_deposit'
                AND "timestamp" < addDays("time_end", -1)
              GROUP BY "contract_address"
            )
            SELECT
              "contract_address",
              "token_0_amount",
              "token_1_amount",
              toFloat64("token_0_amount") * "token_0_price" as "token_0_value",
              toFloat64("token_1_amount") * "token_1_price" as "token_1_value"
            FROM balance
          ),
          swaps_valued AS (
            WITH
              shares AS (
                WITH (SELECT "time_end" FROM time_period) as "time_end"
                SELECT
                  "timestamp",
                  "height",
                  "block_part_index",
                  "tx_index",
                  "event_index",
                  "TokenZero",
                  "TokenOne",
                  "Receiver",
                  "price_timestamp",
                  "value_in_0",
                  "value_in_1",
                  "value_fee_0",
                  "value_fee_1",
                  "value_out_0",
                  "value_out_1"
                FROM spacebox.dex_swaps_valued as s
                WHERE "timestamp" >= addDays("time_end", -"period_in_days")
                  AND "timestamp" < "time_end"
                  AND (
                  notEmpty("Receiver") OR (
                    ("TrancheKey" IS NULL) AND (
                      -- temp override: assume supervault is the only AMM user on the pair
                      --                see commit for previous estimation
                      "Fee" > 0
                    )
                  )
                )
              )
            -- make sure the transfer rows are deduplicated to prevent double counting
            SELECT
              -- count the values from the rows with the latest prices
              argMax("timestamp", "price_timestamp") as "timestamp",
              argMax("TokenZero", "price_timestamp") as "TokenZero",
              argMax("TokenOne", "price_timestamp") as "TokenOne",
              argMax("Receiver", "price_timestamp") as "Receiver",
              argMax("value_in_0", "price_timestamp") as "value_in_0",
              argMax("value_in_1", "price_timestamp") as "value_in_1",
              argMax("value_fee_0", "price_timestamp") as "value_fee_0",
              argMax("value_fee_1", "price_timestamp") as "value_fee_1",
              argMax("value_out_0", "price_timestamp") as "value_out_0",
              argMax("value_out_1", "price_timestamp") as "value_out_1"
            FROM shares
            GROUP BY
              "height",
              "block_part_index",
              "tx_index",
              "event_index"
          ),
          volume_30d AS (
            WITH (SELECT "time_end" FROM time_period) as "time_end"
            SELECT
              "TokenZero",
              "TokenOne",
              "Receiver",
              sum("value_in_1" - "value_fee_1" + "value_out_0") / 2 as "avg_value_0",
              sum("value_in_0" - "value_fee_0" + "value_out_1") / 2 as "avg_value_1"
            FROM (SELECT * FROM swaps_valued WHERE "timestamp" > addDays("time_end", -30))
            GROUP BY
              "TokenZero",
              "TokenOne",
              "Receiver"
          ),
          volume_1d AS (
            WITH (SELECT "time_end" FROM time_period) as "time_end"
            SELECT
              "TokenZero",
              "TokenOne",
              "Receiver",
              sum("value_in_1" - "value_fee_1" + "value_out_0") / 2 as "avg_value_0",
              sum("value_in_0" - "value_fee_0" + "value_out_1") / 2 as "avg_value_1"
              -- OR
              -- sum("value_in_1" - "value_fee_1" + "value_out_0" + "value_in_0" - "value_fee_0" + "value_out_1") / 2 as "avg_value"
            FROM (SELECT * FROM swaps_valued WHERE "timestamp" > addDays("time_end", -1))
            GROUP BY
              "TokenZero",
              "TokenOne",
              "Receiver"
          ),
          volume_prev_1d AS (
            WITH (SELECT "time_end" FROM time_period) as "time_end"
            SELECT
              "TokenZero",
              "TokenOne",
              "Receiver",
              sum("value_in_1" - "value_fee_1" + "value_out_0") / 2 as "avg_value_0",
              sum("value_in_0" - "value_fee_0" + "value_out_1") / 2 as "avg_value_1"
            FROM (
              SELECT * FROM swaps_valued
              WHERE "timestamp" > addDays("time_end", -2)
                AND "timestamp" <= addDays("time_end", -1)
            )
            GROUP BY
              "TokenZero",
              "TokenOne",
              "Receiver"
          ),
          vault_volume as (
            WITH vault_volumes AS (
              SELECT v.*,
                v."contract_address" = v_30d."Receiver" as "is_30d_active",
                v_30d."avg_value_0" + v_30d."avg_value_1" as "volume_30d_value",
                v."contract_address" = v_1d."Receiver" as "is_1d_active",
                v_1d."avg_value_0" + v_1d."avg_value_1" as "volume_1d_value",
                v."contract_address" = v_prev_1d."Receiver" as "is_prev_1d_active",
                v_prev_1d."avg_value_0" + v_prev_1d."avg_value_1" as "volume_prev_1d_value"
              FROM vault_config as v
              LEFT JOIN volume_30d as v_30d
                ON v."token_0_denom" = v_30d."TokenZero"
                AND v."token_1_denom" = v_30d."TokenOne"
              LEFT JOIN volume_1d as v_1d
                ON v."token_0_denom" = v_1d."TokenZero"
                AND v."token_1_denom" = v_1d."TokenOne"
              LEFT JOIN volume_prev_1d as v_prev_1d
                ON v."token_0_denom" = v_prev_1d."TokenZero"
                AND v."token_1_denom" = v_prev_1d."TokenOne"
            )
            SELECT
              "contract_address",
              -- note: active and passive are exclusive and should be added
              --       the vault may swap "actively" on deposit (against passive LPs that are not itself)
              --       it is exclusive because it withdraws all its liquidity before deposit+swap
              --       so it will not be a passive LP against its own trade (trading against itself)
              COALESCE(any(if("is_30d_active" = 1, "volume_30d_value", NULL)), 0) as "active_volume_30d_value",
              COALESCE(any(if("is_30d_active" IS NULL, "volume_30d_value", NULL)), 0) as "passive_volume_30d_value",
              COALESCE(any(if("is_1d_active" = 1, "volume_1d_value", NULL)), 0) as "active_volume_1d_value",
              COALESCE(any(if("is_1d_active" IS NULL, "volume_1d_value", NULL)), 0) as "passive_volume_1d_value",
              COALESCE(any(if("is_prev_1d_active" = 1, "volume_prev_1d_value", NULL)), 0) as "active_volume_prev_1d_value",
              COALESCE(any(if("is_prev_1d_active" IS NULL, "volume_prev_1d_value", NULL)), 0) as "passive_volume_prev_1d_value"
            FROM vault_volumes
            GROUP BY
              "contract_address"
          ),
          apr_30d as (
            WITH
              365 / 30 as periods_per_year, -- 30D periods per year
              period_returns as (${dexVaultReturnTimeseries({
                periods: 1,
                period: 'day',
                limit: 30, // get 30 days worth of day periods
              })})
            SELECT
                "contract_address",

                /* product(1 + r) - 1  in a stable way */
                exp(sumKahan(log1p("vault_return"))) - 1                        AS "total_vault_return",
                exp(sumKahan(log1p("hold_return"))) - 1                         AS "total_hold_return",
                -- compute vault over hold as the percentage from baseline (hold) of the whole period
                (1 + "total_vault_return") / (1 + "total_hold_return") - 1      AS "total_vault_over_hold_return",

                /* Linear annualisation (APR) ------------------------------------ */
                "total_vault_return" * periods_per_year                         AS "vault_apr",
                "total_hold_return" * periods_per_year                          AS "hold_apr",
                "total_vault_over_hold_return" * periods_per_year               AS "vault_over_hold_apr",

                /* Compounded annualisation (APY) ------------------------------- */
                pow(1 + "total_vault_return", periods_per_year) - 1             AS "vault_apy",
                pow(1 + "total_hold_return", periods_per_year) - 1              AS "hold_apy",
                pow(1 + "total_vault_over_hold_return", periods_per_year) - 1   AS "vault_over_hold_apy"
            FROM period_returns
            GROUP BY "contract_address"
          )
        SELECT
          config."updated_at_height" as "height",
          config."created_at" as "created_at",
          config."updated_at" as "updated_at",
          config."contract_address" as "contract_address",
          config."whitelist" as "whitelist",
          config."token_0_denom" as "token_0_denom",
          config."token_0_decimals" as "token_0_decimals",
          config."token_0_symbol" as "token_0_symbol",
          config."token_0_quote_currency" as "token_0_quote_currency",
          config."token_0_max_blocks_old" as "token_0_max_blocks_old",
          config."token_1_denom" as "token_1_denom",
          config."token_1_decimals" as "token_1_decimals",
          config."token_1_symbol" as "token_1_symbol",
          config."token_1_quote_currency" as "token_1_quote_currency",
          config."token_1_max_blocks_old" as "token_1_max_blocks_old",
          config."pool_id" as "pool_id",
          config."deposit_cap" as "deposit_cap",
          config."oracle_contract" as "oracle_contract",
          config."imbalance" as "imbalance",
          config."fee_tier_config" as "fee_tier_config",
          config."timestamp_stale" as "timestamp_stale",
          config."paused" as "paused",
          config."denom" as "denom",
          -- if balance is "on dex" use that value, if withdrawn (0 on dex) quote bank balance
          tvl."token_0_amount" as "amount_0",
          tvl."token_1_amount" as "amount_1",
          tvl."token_0_value" as "tvl_0",
          tvl."token_1_value" as "tvl_1",
          tvl_prev_1d."token_0_value" as "tvl_prev_1d_0",
          tvl_prev_1d."token_1_value" as "tvl_prev_1d_1",
          -- todo: remove when real JOIN is ready
          vol."active_volume_1d_value" + vol."passive_volume_1d_value" as "volume_1d",
          vol."active_volume_prev_1d_value" + vol."passive_volume_prev_1d_value" as "volume_prev_1d",
          vol."active_volume_30d_value" + vol."passive_volume_30d_value" as "volume_30d",
          apr."vault_over_hold_apy" as "apy_vault_over_hold_30d"
        FROM vault_config as config
        ANY LEFT JOIN tvl
          ON config."contract_address" = tvl."contract_address"
        ANY LEFT JOIN tvl_prev_1d
          ON config."contract_address" = tvl_prev_1d."contract_address"
        ANY LEFT JOIN vault_volume as vol
          ON config."contract_address" = vol."contract_address"
        ANY LEFT JOIN apr_30d as apr
          ON config."contract_address" = apr."contract_address"
        ${
          previousResponse
            ? // if this is an incremental update, get changes since known height
              sql`
                WHERE "height" > ${previousResponse.height}
              `
            : // else return all
              sql``
        }
        -- default sort reverse chronologically
        ORDER BY "created_at" DESC
        -- cap limit to max, set default if not well defined
        LIMIT ${Math.min(Number(request.query.limit), MAX_ROWS) || DEFAULT_ROWS}
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        timestamp: sourceTableHeight.data.at(0)?.time,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        getRow: ({ height, ...rest }) => rest,
        getHeight: (data) =>
          Number(data.find((row) => Number(row.height) > 0)?.height),
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => name !== 'height')
              // add reserve field denoms
              ?.map((row) =>
                row.name === 'tvl_0' || row.name === 'tvl_1'
                  ? { ...row, units: 'USD' }
                  : row
              )
              // add time units
              ?.map((row) =>
                row.name === 'created_at' || row.name === 'updated_at'
                  ? { ...row, units: 'YYYY-MM-DD hh:mm:ss UTC' }
                  : row
              )
          );
        },
        ...cacheConfig,
        // allow this route to take longer if required (user has max 300s limit)
        clickhouseSettings: {
          max_execution_time: 120,
        },
      }
    );
  },
  updateState: (state: Response[], dataUpdates: Response[]) => {
    return dataUpdates.reduce((state, vaultUpdate) => {
      return state.map((vault) => {
        // return updated vault
        return vault.contract_address === vaultUpdate.contract_address
          ? vaultUpdate
          : vault;
      });
    }, state);
  },
  handleAdditionalStreams: ({ query }, routeResults) => {
    const streams = query.with?.split(',') || [];
    return {
      ...(streams.includes('tvl') &&
        Object.fromEntries(
          routeResults.data.map((vault) => {
            const route = `/vaults/tvl/${vault.contract_address}?period=day&limit=1`;
            const getData: GetData<TvlRequest, TvlResponse> = (
              _request,
              abortSignal,
              previousResponse
            ) =>
              tvlRoute.handler(
                {
                  params: { contract: vault.contract_address },
                  // default to last month (5 weeks + one day rounding) in days
                  query: { period: 'day', limit: '1' },
                },
                abortSignal,
                previousResponse
              );
            return [route, getData];
          }) || []
        )),
      ...(streams.includes('apr') &&
        Object.fromEntries(
          routeResults.data.map((vault) => {
            const route = `/vaults/apr/${vault.contract_address}?period=day&limit=1`;
            const getData: GetData<AprRequest, AprResponse> = (
              _request,
              abortSignal,
              previousResponse
            ) =>
              aprRoute.handler(
                {
                  params: { contract: vault.contract_address },
                  // default to last month (5 weeks + one day rounding) in days
                  query: { period: 'day', limit: '1' },
                },
                abortSignal,
                previousResponse
              );
            return [route, getData];
          }) || []
        )),
      ...(streams.includes('shares') &&
        Object.fromEntries(
          routeResults.data.map((vault) => {
            const route = `/vaults/shares/${vault.contract_address}?limit=1`;
            const getData: GetData<SharesRequest, SharesResponse> = (
              _request,
              abortSignal,
              previousResponse
            ) =>
              sharesRoute.handler(
                {
                  params: { contract: vault.contract_address },
                  query: { limit: '1' },
                },
                abortSignal,
                previousResponse
              );
            return [route, getData];
          }) || []
        )),
      ...(streams.includes('volume') &&
        Object.fromEntries(
          routeResults.data.map((vault) => {
            const route = `/vaults/volume/${vault.contract_address}?period=day&limit=1`;
            const getData: GetData<VolumeRequest, VolumeResponse> = (
              _request,
              abortSignal,
              previousResponse
            ) =>
              volumeRoute.handler(
                {
                  params: { contract: vault.contract_address },
                  // default to last 24H
                  query: {},
                },
                abortSignal,
                previousResponse
              );
            return [route, getData];
          }) || []
        )),
    };
  },
};
