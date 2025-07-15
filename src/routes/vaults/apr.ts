import sql from 'sql-template-tag';

import { Route } from '../../types';
import { getCachedResponse } from '../../utils/cache-query';
import {
  WithFillTimePeriod,
  toUnixTime,
  getTimePeriod,
} from '../../utils/units';
import dexVaultReturnTimeseries from '../../common-table-expressions/dexVaultReturnTimeseries';
import { getEndTimeCacheConfig } from './_common';

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
  vault_apr: number;
  hold_apr: number;
}

export const route: Route<Request, Response> = {
  method: 'get',
  path: '/vaults/:contract/apr',
  handler: async (request, abortSignal) => {
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

    // ClickHouse will compare either native strings or Unix timestamps
    const unixTo = Number(request.query.to) || 0;

    // get timeseries data
    return await getCachedResponse<
      Response & { height: number; apr_percentage: number },
      Response
    >(
      sql`
        WITH
          vault_returns as (${dexVaultReturnTimeseries({
            contractAddress: request.params.contract,
            period: getTimePeriod(request.query.period) || undefined,
            periods: Number(request.query.periods) || undefined,
            limit: Number(request.query.limit) || undefined,
            unixTimeStart: Number(request.query.from) || undefined,
            unixTimeEnd: Number(request.query.to) || undefined,
          })})
          SELECT
            "time_period" as "time",
            "vault_apr_period" as "vault_apr",
            "hold_apr_period" as "hold_apr"
          FROM vault_returns
      `,
      abortSignal,
      {
        heartbeat: Number(currentHeight?.data.at(0)?.height),
        timestamp: currentHeight?.data.at(0)?.time,
        getRow: ({ time, vault_apr, hold_apr }) => ({
          time,
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
          !!unixTo && toUnixTime(currentHeight?.data.at(0)?.time) > unixTo,
        ...cacheConfig,
      }
    );
  },
};
