import sql, { raw } from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import {
  getFillableTimePeriod,
  WithFillTimePeriod,
  toUnixTime,
} from '../../utils/units';
import { endTime, getEndTimeCacheConfig } from './_common';

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
    const timeContractV1Start = toUnixTime('2025-06-25 05:36:35');
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
                  AND "timestamp" >= toDateTime(${unixTimes.time_data_start})
                  AND "timestamp" < toDateTime(${unixTimes.time_end})
                  AND (
                  "Receiver" = ${request.params.contract} OR (
                    ("TrancheKey" IS NULL) AND (
                      -- temp estimation of vault DEX pools by excluding normal DEX users
                      ("Fee" NOT IN (1, 5, 10, 20, 50, 100, 150, 200)) OR
                      ("block_part_index" = 1)
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
              toStartOfInterval("timestamp", INTERVAL ${raw(
                timePeriods.toFixed(0)
              )} ${raw(timePeriod)}) AS "time",
              max("height") as "height",
              sumIf("value_in_1" - "value_fee_1" + "value_out_0", notEmpty("Receiver")) / 2 as "volume_0_taker",
              sumIf("value_in_0" - "value_fee_0" + "value_out_1", notEmpty("Receiver")) / 2 as "volume_1_taker",
              sumIf("value_in_1" - "value_fee_1" + "value_out_0", "Receiver" IS NULL) / 2 as "volume_0_maker",
              sumIf("value_in_0" - "value_fee_0" + "value_out_1", "Receiver" IS NULL) / 2 as "volume_1_maker",
              sumIf("value_fee_0", notEmpty("Receiver")) as "fees_0_taker",
              sumIf("value_fee_1", notEmpty("Receiver")) as "fees_1_taker",
              sumIf("value_fee_0", "Receiver" IS NULL) as "fees_0_maker",
              sumIf("value_fee_1", "Receiver" IS NULL) as "fees_1_maker"
            FROM swaps_valued
            GROUP BY "time"
          )
        SELECT
          time_range."timestamp" as "time",
          "height",
          "volume_0_taker",
          "volume_1_taker",
          "volume_0_maker",
          "volume_1_maker"
        FROM time_range
        ANY LEFT JOIN timeseries
          ON (time_range."timestamp" = timeseries."time")
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
        isComplete: !!unixTo && unixTimes.time_end > unixTo,
        ...cacheConfig,
      }
    );
  },
};
