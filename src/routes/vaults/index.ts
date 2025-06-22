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
          vault_config as (
            SELECT * FROM spacebox.dex_vaults_config_state
          ),
          swaps_valued AS (
            SELECT *
            FROM spacebox.dex_swaps_valued as s
            WHERE timestamp > addDays(NOW(), -30) AND (
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
            FROM (SELECT * FROM swaps_valued WHERE timestamp > addDays(NOW(), -30))
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
            FROM (SELECT * FROM swaps_valued WHERE timestamp > addDays(NOW(), -1))
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
          if (deposited."token_0_balance" > 0, deposited."token_0_balance", bank_0."balance") as "amount_0",
          if (deposited."token_1_balance" > 0, deposited."token_1_balance", bank_1."balance") as "amount_1",
          toFloat64("amount_0") * toFloat64(price_0."price") * exp10(-(config."token_0_decimals" + price_0."decimals")) as "tvl_0",
          toFloat64("amount_1") * toFloat64(price_1."price") * exp10(-(config."token_1_decimals" + price_1."decimals")) as "tvl_1",
          -- todo: remove when real JOIN is ready
          vol."active_volume_1d_value" + vol."passive_volume_1d_value" as "volume_1d",
          vol."active_volume_30d_value" + vol."passive_volume_30d_value" as "volume_30d",
          (rand() % 1000000)/ 1000000 as "apr_30d"
        FROM vault_config as config
        -- join to current wallet (off-dex) balance
        ANY LEFT JOIN spacebox.bank_transfer_state as bank_0
          ON config."contract_address" = bank_0."address"
          AND config."token_0_denom" = bank_0."denom"
        ANY LEFT JOIN spacebox.bank_transfer_state as bank_1
          ON config."contract_address" = bank_1."address"
          AND config."token_1_denom" = bank_1."denom"
        -- join to current reserves (on-dex) balance
        ANY LEFT JOIN spacebox.dex_vaults_dex_balance_state as deposited
          ON config."contract_address" = deposited."contract_address"
        -- join to current slinky prices
        -- note: this should eventually be replaced with deposited.price attributes
        ANY LEFT JOIN spacebox.slinky_prices_state as price_0
          ON price_0."quote" = 'USD'
          AND price_0."base" = config."token_0_symbol"
        ANY LEFT JOIN spacebox.slinky_prices_state as price_1
          ON price_1."quote" = 'USD'
          AND price_1."base" = config."token_1_symbol"
        ANY LEFT JOIN vault_volume as vol
          ON config."contract_address" = vol."contract_address"
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
