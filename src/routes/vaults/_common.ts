import sql from 'sql-template-tag';
import {
  getTimePeriod,
  inMs,
  minutes,
  toUnixTime,
  WithFillTimePeriod,
} from '../../utils/units';
import { getCachedResponse } from '../../utils/cache-query';
import timeRange from '../../common-table-expressions/timeRange';

// align end of timeseries to the same time for better cached data consistency
export const endTime = sql`toStartOfInterval(addMinutes(NOW(), -5), INTERVAL 5 MINUTE)`;
export const endTimeCacheTime = 5 * minutes * inMs;

type CacheTimeConfig = {
  cacheTime: number;
  staleTimeMax: number;
  staleTimeMin: number;
  cacheVersion: number;
};

export async function getEndTimeCacheConfig(
  abortSignal: AbortSignal
): Promise<CacheTimeConfig> {
  // cache to specific end time
  const cacheTimestamp = await getCachedResponse<{ time: string }>(
    sql`SELECT ${endTime} as "time"`,
    abortSignal
  );
  return {
    cacheTime: 2 * endTimeCacheTime,
    staleTimeMax: 2 * endTimeCacheTime,
    staleTimeMin: 0.4 * endTimeCacheTime, // attempt regen-while-stale at least twice
    cacheVersion: toUnixTime(cacheTimestamp.data.at(0)?.time),
  };
}

export function getValidTimePeriods(
  query: {
    periods?: string;
    period?: WithFillTimePeriod;
  } = {}
) {
  const timePeriods = Math.max(Number(query.periods), 0) || undefined;
  const timePeriod = getTimePeriod(query.period) || undefined;
  return { timePeriods, timePeriod };
}

export type TimeSeriesQuery = {
  fromPrevious?: string;
  from?: string;
  to?: string;
  periods?: string;
  period?: WithFillTimePeriod;
  limit?: string;
};

export async function getAllTimes(
  query: TimeSeriesQuery,
  abortSignal: AbortSignal,
  cacheConfig: CacheTimeConfig
) {
  // get requested time period or default

  const { timePeriods = 1, timePeriod = 'minute' } = getValidTimePeriods(query);
  const unixTimes = await getUnixTimes(query, abortSignal, cacheConfig);

  return (
    unixTimes && {
      periods: timePeriods,
      period: timePeriod,
      unixTimeStart: unixTimes.time_start,
      unixTimeEnd: unixTimes.time_end,
    }
  );
}

export async function getUnixTimes(
  query: TimeSeriesQuery,
  abortSignal: AbortSignal,
  cacheConfig: CacheTimeConfig
) {
  return await getCachedResponse<{
    time_end: number;
    time_start: number;
  }>(
    sql`
      WITH time_range as (${timeRange(query)})
      SELECT
        toUnixTimestamp("time_start") as "time_start",
        toUnixTimestamp("time_end") as "time_end"
      FROM time_range
    `,
    abortSignal,
    cacheConfig
  ).then((r) => r.data.at(0));
}
