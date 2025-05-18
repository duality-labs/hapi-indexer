import sql from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import { inMs, minutes } from '../../utils/units';
import { selectVaultConfigs } from '../../common-table-expressions/vaultConfigs';
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
  owner: string[];
  token_0_denom: string;
  token_0_decimals: number;
  token_0_symbol: string;
  token_0_quote_currency: string;
  token_0_max_blocks_stale: string;
  token_1_denom: string;
  token_1_decimals: number;
  token_1_symbol: string;
  token_1_quote_currency: string;
  token_1_max_blocks_stale: string;
  token_order: string[];
  pool_id: string;
  deposit_cap: string;
  oracle_contract: string;
  imbalance: string;
  fee_tier_config: string;
  timestamp_stale: string;
  paused: false;
  denom: string;
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
      getCachedResponse<{ height: string }>(
        sql`
            SELECT max("height") AS "height"
            FROM spacebox."dex_vaults_dex_balance_state"
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
        SELECT
          config."height" as "height",
          config."created_at" as "created_at",
          config."updated_at" as "updated_at",
          config."contract_address" as "contract_address",
          config."owner" as "owner",
          config."token_0_denom" as "token_0_denom",
          config."token_0_decimals" as "token_0_decimals",
          config."token_0_symbol" as "token_0_symbol",
          config."token_0_quote_currency" as "token_0_quote_currency",
          config."token_0_max_blocks_stale" as "token_0_max_blocks_stale",
          config."token_1_denom" as "token_1_denom",
          config."token_1_decimals" as "token_1_decimals",
          config."token_1_symbol" as "token_1_symbol",
          config."token_1_quote_currency" as "token_1_quote_currency",
          config."token_1_max_blocks_stale" as "token_1_max_blocks_stale",
          config."estimated_token_order" as "estimated_token_order",
          config."pool_id" as "pool_id",
          config."deposit_cap" as "deposit_cap",
          config."oracle_contract" as "oracle_contract",
          config."imbalance" as "imbalance",
          config."fee_tier_config" as "fee_tier_config",
          config."timestamp_stale" as "timestamp_stale",
          config."paused" as "paused",
          config."denom" as "denom",
          (bank_0."balance" + deposited."token_0_balance") as "amount_0",
          (bank_1."balance" + deposited."token_1_balance") as "amount_1",
          toFloat64("amount_0") * toFloat64(price_0."price") * exp10(-(config."token_0_decimals" + price_0."decimals")) as "tvl_0",
          toFloat64("amount_1") * toFloat64(price_1."price") * exp10(-(config."token_1_decimals" + price_1."decimals")) as "tvl_1"
        FROM (${selectVaultConfigs}) as config
        -- join to current wallet (off-dex) balance
        LEFT JOIN spacebox.bank_transfer_state as bank_0
          ON config."contract_address" = bank_0."address"
          AND config."token_0_denom" = bank_0."denom"
        LEFT JOIN spacebox.bank_transfer_state as bank_1
          ON config."contract_address" = bank_1."address"
          AND config."token_1_denom" = bank_1."denom"
        -- join to current reserves (on-dex) balance
        LEFT JOIN spacebox.dex_vaults_dex_balance_state as deposited
          ON config."contract_address" = deposited."contract_address"
        -- join to current slinky prices
        -- note: this should eventually be replaced with deposited.price attributes
        LEFT JOIN spacebox.slinky_prices_state as price_0
          ON price_0."quote" = 'USD'
          AND price_0."base" = config."token_0_symbol"
        LEFT JOIN spacebox.slinky_prices_state as price_1
          ON price_1."quote" = 'USD'
          AND price_1."base" = config."token_1_symbol"
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
                  // default to last month (5 weeks + one day rounding) in days
                  query: { period: 'day', limit: '1' },
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
