import sql, { raw } from 'sql-template-tag';
import { TimePeriod } from '../utils/units';
import { endTime } from '../routes/vaults/_common';

export default function timeRangeTimeseries({
  contractAddress,
  period = 'hour',
  periods = 1,
  unixTimeStart = 0,
  unixTimeEnd = endTime as unknown as number, // not actually number but works
}: {
  contractAddress?: string;
  period?: TimePeriod;
  periods?: number;
  unixTimeStart?: number;
  unixTimeEnd?: number;
} = {}) {
  const interval = raw(`INTERVAL ${periods} ${period}`);
  return sql`
    WITH
      toDateTime(${unixTimeStart}) as "time_start",
      toDateTime(${unixTimeEnd}) as "time_end",
      subDate(
        "time_end",
        INTERVAL "generate_series" ${raw(period)}
      ) as "timestamp"
    SELECT
      -- pass through contract address for joins if needed
      ${
        contractAddress
          ? sql`${contractAddress} as "contract_address"`
          : raw('')
      },
      greatest(
        toStartOfInterval("timestamp", ${interval}),
        toDateTime(${unixTimeStart})
      ) as "time_period_start",
      least(
        toStartOfInterval(dateAdd("timestamp", ${interval}), ${interval}),
        toDateTime(${unixTimeEnd})
      ) as "time_period_end"
    FROM generate_series(
      0,
      dateDiff(${raw(period)}, "time_start", "time_end"),
      ${periods}
    )
  `;
}
