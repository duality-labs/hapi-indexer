import sql, { raw } from 'sql-template-tag';
import { getTimePeriod, toUnixTime } from '../utils/units';
import {
  getValidTimePeriods,
  endTime,
  TimeSeriesQuery,
} from '../routes/vaults/_common';

export default function timeRange(query: TimeSeriesQuery = {}) {
  // get requested time period or default
  const { timePeriods = 1, timePeriod = 'minute' } = getValidTimePeriods(query);
  const last24H = !getTimePeriod(query.period);
  const limit =
    Math.round(Math.max(Number(query.limit), 0)) || (last24H ? 60 * 24 : 1);

  // get previous query limit
  const timePrevious = toUnixTime(query.fromPrevious);
  // ClickHouse will compare either native strings or Unix timestamps
  const unixFrom = Number(query.from) || 0;
  const unixTo = Number(query.to) || 0;

  return sql`
    SELECT
      greatest(
        toDateTime(${unixFrom || timePrevious}),
        ${
          limit
            ? sql`subDate(toDateTime("time_end"), INTERVAL ${raw(
                (timePeriods * limit).toFixed(0)
              )} ${raw(timePeriod)})`
            : sql`toDateTime(0)`
        }
      ) as "time_start",
      least(
        ${endTime},
        ${unixTo ? sql`toDateTime(${unixTo})` : sql`NOW()`}
      ) as "time_end"
  `;
}
