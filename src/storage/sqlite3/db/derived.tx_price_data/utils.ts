export const resolutionTimeFormats = {
  second: '%Y-%m-%d %H:%M:%S',
  minute: '%Y-%m-%d %H:%M:00',
  hour: '%Y-%m-%d %H:00:00',
  day: '%Y-%m-%d 00:00:00',
  month: '%Y-%m-01 00:00:00',
} as const;

export type Resolution = keyof typeof resolutionTimeFormats;
