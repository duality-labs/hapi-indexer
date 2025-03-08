// unix time constants
export const seconds = 1;
export const minutes = 60 * seconds;
export const hours = 60 * minutes;
export const days = 24 * hours;
// add conversion to JS milliseconds (eg. 1 * minute * inMs)
export const inMs = 1000;

export const timePeriods = ['day', 'hour', 'minute', 'seconds'] as const;
export type TimePeriod = (typeof timePeriods)[number];

// whitelist user given time period
export function getTimePeriod(
  timePeriod: string | undefined
): TimePeriod | undefined {
  if (timePeriod) {
    const timePeriodLowerCase = timePeriod.toLowerCase();
    return timePeriods.find((timePeriod) => timePeriod === timePeriodLowerCase);
  }
}
