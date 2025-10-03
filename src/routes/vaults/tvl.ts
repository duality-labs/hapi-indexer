import sql from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import { WithFillTimePeriod } from '../../utils/units';
import { endTime, getAllTimes, getEndTimeCacheConfig } from './_common';
import timeRangeTimeseries from '../../common-table-expressions/timeRangeTimeseries';

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

    // get query times
    const time = await getAllTimes(
      {
        ...request.query,
        fromPrevious: previousResponse?.data.at(0)?.time,
      },
      abortSignal,
      cacheConfig
    );

    if (!time) {
      throw new Error('Invalid start/end times');
    }

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        WITH
          time_range AS (${timeRangeTimeseries({
            ...time,
            contractAddress: request.params.contract,
          })}),
          balance_valued AS (
            WITH
              balance_start AS (
                SELECT
                  "timestamp",
                  argMax("height_to", "timestamp") as "height",
                  "contract_address",
                  argMax("token_0_value", "timestamp") as "token_0_value",
                  argMax("token_1_value", "timestamp") as "token_1_value"
                FROM spacebox.dex_vaults_dex_balance_valued_by_minute
                WHERE "contract_address" = ${request.params.contract}
                  AND "timestamp" <= toDateTime(${time.unixTimeStart})
                GROUP BY "contract_address", "timestamp"
                ORDER BY "timestamp" DESC
                LIMIT 1
              ),
              balance_timeseries AS (
                SELECT
                  "timestamp",
                  argMax("height_to", "timestamp") as "height",
                  "contract_address",
                  argMax("token_0_value", "timestamp") as "token_0_value",
                  argMax("token_1_value", "timestamp") as "token_1_value"
                FROM spacebox.dex_vaults_dex_balance_valued_by_minute
                WHERE "contract_address" = ${request.params.contract}
                  AND "timestamp" >= toDateTime(${time.unixTimeStart})
                  AND "timestamp" < toDateTime(${time.unixTimeEnd})
                GROUP BY "contract_address", "timestamp"
                ORDER BY "timestamp" DESC
              )
            SELECT * FROM balance_timeseries
            UNION ALL
            SELECT * FROM balance_start
          ),
          timeseries as (
            SELECT
              "timestamp" AS "time",
              argMax("contract_address", "timestamp") AS "contract_address",
              argMax("height", "timestamp") as "height",
              argMax("token_0_value", "timestamp") as "token_0_value",
              argMax("token_1_value", "timestamp") as "token_1_value"
            FROM balance_valued
            GROUP BY "time"
            ORDER BY "time" DESC
          ),
          union as (
            SELECT
              time_range."time_period_end" as "time",
              "height",
              "token_0_value" as "tvl_0",
              "token_1_value" as "tvl_1"
            FROM time_range
            ASOF LEFT JOIN timeseries
              ON (time_range."contract_address" = timeseries."contract_address")
              AND ("time" >= timeseries."time")
            -- default sort reverse chronologically
            ORDER BY "time" DESC
            -- cap limit to max, set default if not well defined
            LIMIT ${
              Math.min(Number(request.query.limit) + 1, MAX_ROWS) ||
              DEFAULT_ROWS
            }
            UNION ALL
            SELECT
              time_range."time_period_start" as "time",
              "height",
              "token_0_value" as "tvl_0",
              "token_1_value" as "tvl_1"
            FROM time_range
            ASOF LEFT JOIN timeseries
              ON (time_range."contract_address" = timeseries."contract_address")
              AND ("time" >= timeseries."time")
            -- default sort reverse chronologically
            ORDER BY "time" ASC
            -- cap limit to max, set default if not well defined
            LIMIT 1
          )
        SELECT *
        FROM union
        ORDER BY "time" DESC
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
          !!Number(request.query.to) &&
          time.unixTimeEnd > Number(request.query.to),
        ...cacheConfig,
      }
    );
  },
};
