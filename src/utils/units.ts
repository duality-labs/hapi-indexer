// unix time constants
export const seconds = 1;
export const minutes = 60 * seconds;
export const hours = 60 * minutes;
export const days = 24 * hours;
// add conversion to JS milliseconds (eg. 1 * minute * inMs)
export const inMs = 1000;

const fillableTimePeriods = [
  'millisecond',
  'second',
  'minute',
  'hour',
  'day',
  'week',
] as const;
export type WithFillTimePeriod = (typeof fillableTimePeriods)[number];

const timePeriods = [...fillableTimePeriods, 'month'] as const;
export type TimePeriod = (typeof timePeriods)[number];

// whitelist user given time period
function getBaseTimePeriod(
  timePeriod: string | undefined,
  timePeriods: readonly string[]
): (typeof timePeriods)[number] | undefined {
  if (timePeriod) {
    const timePeriodLowerCase = timePeriod.toLowerCase();
    return timePeriods.find((period) => period === timePeriodLowerCase);
  }
}

export function getTimePeriod(
  timePeriod: TimePeriod | undefined
): TimePeriod | undefined;
export function getTimePeriod(
  timePeriod: string | undefined
): string | undefined {
  return getBaseTimePeriod(timePeriod, timePeriods);
}

// whitelist user given time period
export function getFillableTimePeriod(
  timePeriod: string | undefined
): string | undefined {
  return getBaseTimePeriod(timePeriod, fillableTimePeriods);
}

/**
 * Convert ClickHouse DateTime string ("YYYY-MM-DD hh:mm:ss") to unixTime
 * @param dateTime
 * @returns unix time in seconds
 */
export function toUnixTime(dateTime: string | undefined): number {
  const date = new Date(`${dateTime}Z`);
  return date.valueOf() > 0 ? Math.floor(date.valueOf() / 1000) : 0;
}
