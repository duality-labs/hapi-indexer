import sql from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import {
  WithFillTimePeriod,
  toUnixTime,
  getTimePeriod,
} from '../../utils/units';
import dexVaultReturnTimeseries from '../../common-table-expressions/dexVaultReturnTimeseries';
import { getAllTimes, getEndTimeCacheConfig } from './_common';
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
  time_end: string;
  vault_apr: number;
  hold_apr: number;
}

const MAX_ROWS = 10000;

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/:contract/apr',
  handler: async (request, abortSignal, previousResponse) => {
    // cache to specific end time
    const cacheConfig = await getEndTimeCacheConfig(abortSignal);

    // get timeseries data height (quick query to determine cache version)
    const allUpdateHeights = await Promise.all([
      getCachedResponse<{ height: string; time: string }>(
        sql`
          SELECT max("height") AS "height", max("timestamp") AS "time"
          FROM spacebox.dex_vaults_events_dex_deposit_state
          WHERE "contract_address" = ${request.params.contract}
        `,
        abortSignal,
        cacheConfig
      ),
      getCachedResponse<{ height: string; time: string }>(
        sql`
          SELECT max("height") AS "height", max("timestamp") AS "time"
          FROM spacebox.dex_vaults_shares_state
          WHERE "contract_address" = ${request.params.contract}
        `,
        abortSignal,
        cacheConfig
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
    return await getCachedResponse<
      Response & { height: number; apr_percentage: number },
      Response
    >(
      sql`
        WITH
          time_range AS (${timeRangeTimeseries({
            ...time,
            contractAddress: request.params.contract,
          })}),
          vault_returns as (${dexVaultReturnTimeseries({
            ...time,
            contractAddress: request.params.contract,
          })})
        SELECT
          time_range."time_period_start" as "time",
          time_range."time_period_end" as "time_end",
          "vault_apr_period" as "vault_apr",
          "hold_apr_period" as "hold_apr",
          "hold_0_apr_period" as "hold_0_apr",
          "hold_1_apr_period" as "hold_1_apr",
          "vault_over_hold_apr_period" as "vault_over_hold_apr"
        FROM time_range
        ASOF LEFT JOIN vault_returns as timeseries
          ON (time_range."contract_address" = timeseries."contract_address")
          AND (time_range."time_period_start" >= timeseries."time_period")
        -- default sort reverse chronologically
        ORDER BY "time" DESC
        -- cap limit to max
        LIMIT ${MAX_ROWS}
      `,
      abortSignal,
      {
        heartbeat: Number(currentHeight?.data.at(0)?.height),
        timestamp: currentHeight?.data.at(0)?.time,
        getRow: ({ time, time_end, vault_apr, hold_apr }) => ({
          time,
          time_end,
          vault_apr,
          hold_apr,
        }),
        getHeight: () => Number(currentHeight?.data.at(0)?.height),
        getMetadata: (metadata) => {
          return (
            metadata
              // remove height field
              ?.filter(({ name }) => name !== 'height')
              // add period time
              ?.map((row) =>
                row.name.endsWith('_apr')
                  ? {
                      ...row,
                      units: `APR of ${Number(request.query.periods) || 1} ${
                        getTimePeriod(request.query.period) || 'hour'
                      } period`,
                    }
                  : { ...row }
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
          toUnixTime(currentHeight?.data.at(0)?.time) >
            Number(request.query.to),
        ...cacheConfig,
      }
    );
  },
};
