import sql from 'sql-template-strings';

import db from './db';
import { PaginatedResponse, PaginationInput } from './paginationUtils';

// use a common data shape for time series data
type TimeseriesDataRow = [time_unix: number, values: Array<number | string>];

// creates the expected response from a given timeseries-like DataRow
// eg. if type DataRow = [number, [number, number, number]]
//   then: TimeseriesResponse['shape'] = ['time_unix', [string, string, string]]
export interface TimeseriesResponse<DataRow extends TimeseriesDataRow>
  extends PaginatedResponse {
  shape: ['time_unix', FixedLengthArray<string, DataRow[1]['length']>];
  data: Array<DataRow>;
}

export const resolutionTimeFormats = {
  second: '%Y-%m-%d %H:%M:%S',
  minute: '%Y-%m-%d %H:%M:00',
  hour: '%Y-%m-%d %H:00:00',
  day: '%Y-%m-%d 00:00:00',
  month: '%Y-%m-01 00:00:00',
} as const;

export type Resolution = keyof typeof resolutionTimeFormats;

// calculate how far from the start of day we are in secods
async function getStartOfDayOffset(pagination: PaginationInput) {
  const { offset } = await db.get(sql`
    SELECT (
      ${pagination.before} - unixepoch(
        datetime(${pagination.before}, "unixepoch"),
        "start of day"
      )
    ) as 'offset'
  `);
  return offset;
}

// if a query is made with option "last24Hours" then offset the windows
// by how far away we are to the last day window
// (because we use the resolutionTimeFormat['day'] to bound window partitions)
export type PeriodType = 'last24Hours';
export async function getOffsetSeconds(
  pagination: PaginationInput,
  periodOffsetType?: PeriodType
) {
  return periodOffsetType === 'last24Hours'
    ? await getStartOfDayOffset(pagination)
    : 0;
}

// use fixed length array type found
// link: https://stackoverflow.com/questions/41139763/how-to-declare-a-fixed-length-array-in-typescript#74801694
type FixedLengthArray<
  T,
  N extends number,
  R extends T[] = []
> = number extends N
  ? T[]
  : R['length'] extends N
  ? R
  : FixedLengthArray<T, N, [T, ...R]>;
