import sql from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import { inMs, minutes } from '../../utils/units';
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
  apr_30d: number;
  volume_1d: number;
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
    const sourceTableHeight = await getCachedResponse<{ height: string }>(
      sql`
        SELECT max("height") AS "height"
        FROM spacebox."raw_block_results"
      `,
      abortSignal
    );

    const currentHeights = await Promise.all([
      getCachedResponse<{ height: string }>(
        sql`
            SELECT max("height") AS "height"
            FROM spacebox."dex_vaults_config_tx_event"
          `,
        abortSignal
      ),
      // note: use changes in user deposits/withdrawals to the vault
      //       as a better indicator of major updates to TVL
      //       although the query depends on spacebox.bank_transfer_state
      //       and spacebox.dex_vaults_dex_balance_state: this changes TVL
      //       very little compared to user deposits and withdrawals
      getCachedResponse<{ height: string }>(
        sql`
            SELECT max("height") AS "height"
            FROM spacebox."dex_vaults_shares"
          `,
        abortSignal
      ),
    ]);

    const currentHeight = Math.max(
      ...currentHeights.map(
        (response) => Number(response.data.at(0)?.height) || 0
      )
    );

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        WITH
          toStartOfInterval(addMinutes(NOW(), -5), INTERVAL 5 MINUTE) as "time_end",
          vault_config as (
            SELECT * FROM spacebox.dex_vaults_config_state
          ),
          tvl AS (
            WITH balance AS (
              SELECT
                "contract_address",
                argMax("token_0_balance_before_deposit", "height") as "token_0_amount",
                argMax("token_1_balance_before_deposit", "height") as "token_1_amount",
                argMax("token_0_price", "height") as "token_0_price",
                argMax("token_1_price", "height") as "token_1_price"
              FROM spacebox.dex_vaults_dex_balance as b
              WHERE "action" = 'dex_deposit'
                AND "timestamp" <= time_end
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
            SELECT *
            FROM spacebox.dex_swaps_valued as s
            WHERE "timestamp" > addDays(time_end, -30)
              AND "timestamp" <= time_end
              AND (
              notEmpty("Receiver") OR (
                ("TrancheKey" IS NULL) AND (
                  -- temp estimation of vault DEX pools by excluding normal DEX users
                  ("Fee" NOT IN (1, 5, 10, 20, 50, 100, 150, 200)) OR
                  ("block_part_index" = 1)
                )
              )
            )
          ),
          volume_30d AS (
            SELECT
              "TokenZero",
              "TokenOne",
              "Receiver",
              sum("value_in_1" - "value_fee_1" + "value_out_0") / 2 as "avg_value_0",
              sum("value_in_0" - "value_fee_0" + "value_out_1") / 2 as "avg_value_1"
            FROM (SELECT * FROM swaps_valued WHERE "timestamp" > addDays(time_end, -30))
            GROUP BY
              "TokenZero",
              "TokenOne",
              "Receiver"
          ),
          volume_1d AS (
            SELECT
              "TokenZero",
              "TokenOne",
              "Receiver",
              sum("value_in_1" - "value_fee_1" + "value_out_0") / 2 as "avg_value_0",
              sum("value_in_0" - "value_fee_0" + "value_out_1") / 2 as "avg_value_1"
              -- OR
              -- sum("value_in_1" - "value_fee_1" + "value_out_0" + "value_in_0" - "value_fee_0" + "value_out_1") / 2 as "avg_value"
            FROM (SELECT * FROM swaps_valued WHERE "timestamp" > addDays(time_end, -1))
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
                v_1d."avg_value_0" + v_1d."avg_value_1" as "volume_1d_value"
              FROM vault_config as v
              LEFT JOIN volume_30d as v_30d
                ON v."token_0_denom" = v_30d."TokenZero"
                AND v."token_1_denom" = v_30d."TokenOne"
              LEFT JOIN volume_1d as v_1d
                ON v."token_0_denom" = v_1d."TokenZero"
                AND v."token_1_denom" = v_1d."TokenOne"
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
              COALESCE(any(if("is_1d_active" IS NULL, "volume_1d_value", NULL)), 0) as "passive_volume_1d_value"
            FROM vault_volumes
            GROUP BY
              "contract_address"
          ),
          apr_30d as (
            WITH
              30 as "period_in_days",
              365 as "days_in_year",
              addDays(time_end, -"period_in_days") as "time_start",
              balance_start as (
                SELECT
                  toDateTime64("time_start", 9) as "timestamp",
                  "contract_address",
                  argMax("token_0_balance_before_deposit_value", "height") as "token_0_value",
                  argMax("token_1_balance_before_deposit_value", "height") as "token_1_value",
                  argMax("sort_key", "height") as "sort_key"
                FROM spacebox.dex_vaults_dex_balance_valued as b
                WHERE "action" = 'dex_deposit'
                  AND b."timestamp" <= "time_start"
                GROUP BY "contract_address"
              ),
              balance_end as (
                SELECT
                  toDateTime64("time_end", 9) as "timestamp",
                  "contract_address",
                  argMax("token_0_balance_before_deposit_value", "height") as "token_0_value",
                  argMax("token_1_balance_before_deposit_value", "height") as "token_1_value",
                  argMax("sort_key", "height") as "sort_key"
                FROM spacebox.dex_vaults_dex_balance_valued as b
                WHERE "action" = 'dex_deposit'
                  AND b."timestamp" <= "time_end"
                GROUP BY "contract_address"
              ),
              transfers as (
                WITH shares AS (
                  SELECT
                    "timestamp",
                    "contract_address",
                    "value_deposited",
                    "value_withdrawn",
                    "value_close",
                    "sort_key"
                  FROM spacebox.dex_vaults_shares_valued
                  WHERE "timestamp" > "time_start"
                    AND "timestamp" <= "time_end"
                )
                -- make sure the transfer rows are deduplicated to prevent double counting
                SELECT
                  argMax("timestamp", "sort_key") as "timestamp",
                  argMax("contract_address", "sort_key") as "contract_address",
                  argMax("value_deposited", "sort_key") as "value_deposited",
                  argMax("value_withdrawn", "sort_key") as "value_withdrawn",
                  argMax("value_close", "sort_key") as "value_close",
                  "sort_key"
                FROM shares
                GROUP BY "sort_key"
              ),
              timeseries as (
                SELECT
                  "timestamp",
                  "contract_address",
                  0 as "value_deposited",
                  0 as "value_withdrawn",
                  "token_0_value" + "token_1_value" as "value_close",
                  "sort_key"
                FROM balance_start
                UNION ALL
                SELECT
                  "timestamp",
                  "contract_address",
                  "value_deposited",
                  "value_withdrawn",
                  "value_close",
                  "sort_key"
                FROM transfers
                UNION ALL
                SELECT
                  "timestamp",
                  "contract_address",
                  0 as "value_deposited",
                  0 as "value_withdrawn",
                  "token_0_value" + "token_1_value" as "value_close",
                  "sort_key"
                FROM balance_end
              ),
              per_event AS (
                SELECT
                  "contract_address",
                  "timestamp",
                  /* net cash flow at the event */
                  "value_deposited" - "value_withdrawn" AS F,
                  /* value just *before* the cash flow is applied */
                  greatest(0, "value_close" - ("value_deposited" - "value_withdrawn")) AS "value_pre_close",

                  /* previous close inside the same group */
                  lagInFrame("value_close", 1, toFloat64(0)) OVER ascending_events AS "value_previous",
                  lagInFrame("timestamp", 1, toDateTime64(0, 0))  OVER ascending_events AS "timestamp_previous",

                  /* exact log-return between successive valuations */
                  log1p( ( "value_pre_close" - "value_previous" ) / "value_previous" ) AS "ln_return"
                FROM timeseries
                WINDOW ascending_events AS (PARTITION BY "contract_address" ORDER BY "sort_key" ASC)
              )
            SELECT
                "contract_address",
                /* simple-interest annualisation = APR */
                ( exp( sumKahan( "ln_return" ) ) - 1 ) / "period_in_days" * "days_in_year" AS "apr"
            FROM per_event
            WHERE "timestamp_previous" > 0  -- skip the first row per group
              AND "value_pre_close" > 0     -- skip any full-withdrawal rows per group
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
          -- todo: remove when real JOIN is ready
          vol."active_volume_1d_value" + vol."passive_volume_1d_value" as "volume_1d",
          vol."active_volume_30d_value" + vol."passive_volume_30d_value" as "volume_30d",
          apr."apr" as "apr_30d"
        FROM vault_config as config
        ANY LEFT JOIN tvl
          ON config."contract_address" = tvl."contract_address"
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
        cacheTime: 1 * minutes * inMs,
        staleTimeMax: 1 * minutes * inMs,
        staleTimeMin: 0.2 * minutes * inMs,
        cacheVersion: currentHeight,
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
