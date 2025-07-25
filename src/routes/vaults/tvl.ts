import sql, { raw } from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import {
  getFillableTimePeriod,
  WithFillTimePeriod,
  toUnixTime,
} from '../../utils/units';
import { endTime, getEndTimeCacheConfig } from './_common';

interface VaultResponse {
  created_at: string;
  updated_at: string;
  created_at_height: string;
  updated_at_height: string;
  contract_address: string;
  whitelist: string[];
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
  pool_id: string;
  deposit_cap: string;
  timestamp_stale: string;
  fee_tier_config: string;
  paused: boolean;
  skew: boolean;
  imbalance: number;
  oracle_contract: string;
  oracle_price_skew: string;
  denom: string;
}

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
    // cache to specific end time
    const cacheConfig = await getEndTimeCacheConfig(abortSignal);

    const sourceTableHeight = await getCachedResponse<{ height: string }>(
      sql`
        SELECT max("height") AS "height"
        FROM spacebox."raw_block_results"
        WHERE "timestamp" <= ${endTime}
      `,
      abortSignal,
      cacheConfig
    );

    // get timeseries data height (quick query to determine cache version)
    const contractResponse = await getCachedResponse<VaultResponse>(
      sql`
        SELECT *
        FROM spacebox.dex_vaults_config_state
        WHERE "contract_address" = ${request.params.contract}
      `,
      abortSignal,
      cacheConfig
    );

    const data = contractResponse.data.at(0);
    if (!data) {
      throw new Error('NotFound', { cause: 404 });
    }

    const token0 = {
      denom: data.token_0_denom,
      decimals: data.token_0_decimals,
      symbol: data.token_0_symbol,
      quoteCurrency: data.token_0_quote_currency,
    };
    const token1 = {
      denom: data.token_1_denom,
      decimals: data.token_1_decimals,
      symbol: data.token_1_symbol,
      quoteCurrency: data.token_1_quote_currency,
    };

    // get requested time period or default
    const timePeriods = Math.max(Number(request.query.periods), 0) || 1;
    const last24H = !getFillableTimePeriod(request.query.period);
    const timePeriod = getFillableTimePeriod(request.query.period) || 'minute';
    const limit =
      Math.round(Math.max(Number(request.query.limit), 0)) ||
      (last24H ? 60 * 24 : 1);

    // get previous query limit
    const timePrevious = toUnixTime(previousResponse?.data.at(0)?.time);
    // get contract start time
    const timeContractV1Start = 0;
    // ClickHouse will compare either native strings or Unix timestamps
    const unixFrom = Number(request.query.from) || 0;
    const unixTo = Number(request.query.to) || 0;

    const unixTimes = await getCachedResponse<{
      time_end: number;
      time_start: number;
      time_data_start: number;
    }>(
      sql`
        SELECT
          toUnixTimestamp(
            toStartOfInterval(
              greatest(
                toDateTime(${unixFrom || timePrevious}),
                ${
                  limit
                    ? sql`subDate(toDateTime("time_end"), INTERVAL ${raw(
                        limit.toFixed(0)
                      )} ${raw(timePeriod)})`
                    : sql`toDateTime(0)`
                }
              ),
              INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
            )
          ) as "time_start",
          greatest(
            "time_start",
            ${timeContractV1Start}
          ) as "time_data_start",
          toUnixTimestamp(
            toStartOfInterval(
              least(
                ${endTime},
                ${unixTo ? sql`toDateTime(${unixTo})` : sql`NOW()`}
              ),
              INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
            )
          ) as "time_end"
        `,
      abortSignal,
      cacheConfig
    ).then((r) => r.data.at(0));

    if (!unixTimes) {
      throw new Error('Invalid start/end times');
    }

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        WITH
          time_range AS (
            WITH
              toDateTime(${unixTimes.time_start}) as "time_start",
              toDateTime(${unixTimes.time_end}) as "time_end"
            SELECT
              ${request.params.contract} as "contract_address",
              subDate(
                "time_end" - (
                  INTERVAL ${raw(timePeriods.toFixed(0))} ${raw(timePeriod)}
                ),
                INTERVAL "generate_series" ${raw(timePeriod)}
              ) as "timestamp"
            FROM generate_series(
              0,
              dateDiff(${raw(timePeriod)}, "time_start", "time_end"),
              ${timePeriods}
            )
          ),
          balance_valued AS (
            WITH
              balance_start AS (
                SELECT
                  "timestamp",
                  "height",
                  "contract_address",
                  "token_0_balance_before_deposit_value" as "token_0_value",
                  "token_1_balance_before_deposit_value" as "token_1_value",
                  "sort_key"
                FROM spacebox.dex_vaults_dex_balance_valued
                WHERE "contract_address" = ${request.params.contract}
                  AND "action" = 'dex_deposit'
                  AND "timestamp" <= toDateTime(${unixTimes.time_data_start})
                ORDER BY "sort_key" DESC
                LIMIT 1
              ),
              balance_timeseries AS (
                SELECT
                  "timestamp",
                  "height",
                  "contract_address",
                  "token_0_balance_before_deposit_value" as "token_0_value",
                  "token_1_balance_before_deposit_value" as "token_1_value",
                  "sort_key"
                FROM spacebox.dex_vaults_dex_balance_valued
                WHERE "contract_address" = ${request.params.contract}
                  AND "action" = 'dex_deposit'
                  AND "timestamp" >= toDateTime(${unixTimes.time_data_start})
                  AND "timestamp" < toDateTime(${unixTimes.time_end})
                ORDER BY "sort_key" DESC
              )
            SELECT * FROM balance_timeseries
            UNION ALL
            SELECT * FROM balance_start
          ),
          timeseries as (
            SELECT
              toStartOfInterval("timestamp", INTERVAL ${raw(
                timePeriods.toFixed(0)
              )} ${raw(timePeriod)}) AS "time",
              argMax("contract_address", "sort_key") AS "contract_address",
              argMax("height", "sort_key") as "height",
              argMax("token_0_value", "sort_key") as "token_0_value",
              argMax("token_1_value", "sort_key") as "token_1_value"
            FROM balance_valued
            GROUP BY "time"
            ORDER BY "time" DESC
          )
        SELECT
          time_range."timestamp" as "time",
          "height",
          "token_0_value" as "tvl_0",
          "token_1_value" as "tvl_1"
        FROM time_range
        ASOF LEFT JOIN timeseries
          ON (time_range."contract_address" = timeseries."contract_address")
          AND (time_range."timestamp" >= timeseries."time")
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
        isComplete: !!unixTo && unixTimes.time_end > unixTo,
        ...cacheConfig,
      }
    );
  },
};
