import sql from 'sql-template-tag';
import { inMs, minutes, toUnixTime } from '../../utils/units';
import { getCachedResponse } from '../../utils/cache-query';

// align end of timeseries to the same time for better cached data consistency
export const endTime = sql`toStartOfInterval(addMinutes(NOW(), -5), INTERVAL 5 MINUTE)`;
export const endTimeCacheTime = 5 * minutes * inMs;

export async function getEndTimeCacheConfig(abortSignal: AbortSignal) {
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
