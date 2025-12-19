import sql, { raw } from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import { toUnixTime, WithFillTimePeriod } from '../../utils/units';
import { endTime, getAllTimes, getEndTimeCacheConfig } from './_common';
import timeRangeTimeseries from '../../common-table-expressions/timeRangeTimeseries';

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
  volume_0: number;
  volume_1: number;
  fees_0: number;
  fees_1: number;
}
const DEFAULT_ROWS = 100;
const MAX_ROWS = 1000;

interface PriceByVaultStateResponse {
  timestamp: string;
  contract_address: string;
  token_0_price: string;
  token_1_price: string;
}

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/volume/:contract',
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

    const contractFirstDepositResponse =
      await getCachedResponse<PriceByVaultStateResponse>(
        sql`
          SELECT *
          FROM spacebox.price_by_vault_denom_first_state
          WHERE "contract_address" = ${request.params.contract}
        `,
        abortSignal,
        cacheConfig
      );

    const contractFirstDeposit = contractFirstDepositResponse.data.at(0);
    if (!contractFirstDeposit) {
      throw new Error('NotFound', { cause: 404 });
    }

    // get timeseries data
    return await getCachedResponse<Response & { height: string }, Response>(
      sql`
        WITH
          time_range AS (${timeRangeTimeseries({
            ...time,
            contractAddress: request.params.contract,
          })}),
          vault_config AS (
            SELECT
              "token_0_denom",
              "token_1_denom"
            FROM spacebox.dex_vaults_config_state
            WHERE "contract_address" = ${request.params.contract}
            LIMIT 1
          ),
          swaps_valued AS (
            WITH
              swaps AS (
                SELECT
                  "timestamp",
                  "height",
                  "TokenZero",
                  "TokenOne",
                  "Receiver",
                  "value_in_0",
                  "value_in_1",
                  "value_fee_0",
                  "value_fee_1",
                  "value_out_0",
                  "value_out_1",
                  "sort_key"
                FROM spacebox.dex_swaps_valued as s
                WHERE "TokenZero" = (SELECT "token_0_denom" FROM vault_config)
                  AND "TokenOne" = (SELECT "token_1_denom" FROM vault_config)
                  AND "timestamp" >= toDateTime(${
                    // limit to within the contract's actual onchain TVL > 0
                    Math.max(
                      time.unixTimeStart,
                      toUnixTime(contractFirstDeposit.timestamp)
                    )
                  })
                  AND "timestamp" < toDateTime(${time.unixTimeEnd})
                  AND (
                  "Receiver" = ${request.params.contract} OR (
                    ("TrancheKey" IS NULL OR "TrancheKey" = '') AND (
                      -- temp override: assume supervault is the only AMM user on the pair
                      --                see commit for previous estimation
                      "Fee" > 0
                    )
                  )
                )
              )
            -- make sure the transfer rows are deduplicated to prevent double counting
            SELECT
              argMax("timestamp", "sort_key") as "timestamp",
              argMax("height", "sort_key") as "height",
              argMax("TokenZero", "sort_key") as "TokenZero",
              argMax("TokenOne", "sort_key") as "TokenOne",
              argMax("Receiver", "sort_key") as "Receiver",
              argMax("value_in_0", "sort_key") as "value_in_0",
              argMax("value_in_1", "sort_key") as "value_in_1",
              argMax("value_fee_0", "sort_key") as "value_fee_0",
              argMax("value_fee_1", "sort_key") as "value_fee_1",
              argMax("value_out_0", "sort_key") as "value_out_0",
              argMax("value_out_1", "sort_key") as "value_out_1",
              "sort_key"
            FROM swaps
            GROUP BY "sort_key"
          ),
          timeseries as (
            SELECT
              ${request.params.contract} as "_contract_address",
              toStartOfInterval("timestamp", INTERVAL ${raw(
                time.periods.toFixed(0)
              )} ${raw(time.period)}) AS "time_period",
              max("height") as "height",
              sumIf("value_in_1" - "value_fee_1" + "value_out_0", "Receiver" = "_contract_address") / 2 as "volume_0_taker",
              sumIf("value_in_0" - "value_fee_0" + "value_out_1", "Receiver" = "_contract_address") / 2 as "volume_1_taker",
              sumIf("value_in_1" - "value_fee_1" + "value_out_0", "Receiver" IS NULL) / 2 as "volume_0_maker",
              sumIf("value_in_0" - "value_fee_0" + "value_out_1", "Receiver" IS NULL) / 2 as "volume_1_maker",
              sumIf("value_fee_0", "Receiver" = "_contract_address") as "fees_0_taker",
              sumIf("value_fee_1", "Receiver" = "_contract_address") as "fees_1_taker",
              sumIf("value_fee_0", "Receiver" IS NULL) as "fees_0_maker",
              sumIf("value_fee_1", "Receiver" IS NULL) as "fees_1_maker"
            FROM swaps_valued
            GROUP BY "time_period"
          )
        SELECT
          time_range."time_period_start" as "time",
          time_range."time_period_end" as "time_end",
          "height",
          "volume_0_taker",
          "volume_1_taker",
          "volume_0_maker",
          "volume_1_maker"
        FROM time_range
        LEFT JOIN timeseries
          ON (time_range."contract_address" = timeseries."_contract_address")
          AND (time_range."time_period_start" = timeseries."time_period")
        -- default sort reverse chronologically
        ORDER BY "time" DESC
        -- cap limit to max, set default if not well defined
        LIMIT ${Math.min(Number(request.query.limit), MAX_ROWS) || DEFAULT_ROWS}
      `,
      abortSignal,
      {
        heartbeat: Number(sourceTableHeight.data.at(0)?.height),
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        getRow: ({ height, ...row }) => row,
        getHeight: (data) =>
          Number(data.find((row) => Number(row.height) > 0)?.height),
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => name !== 'height')
              // add units (all USD except for time)
              // add time units, convert tick index units
              ?.map((row) =>
                row.name === 'time'
                  ? { ...row, units: 'YYYY-MM-DD hh:mm:ss UTC' }
                  : { ...row, units: 'USD' }
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
