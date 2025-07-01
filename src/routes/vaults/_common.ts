import sql from 'sql-template-tag';

// align end of timeseries to the same time for better cached data consistency
export const endTime = sql`toStartOfInterval(addMinutes(NOW(), -5), INTERVAL 5 MINUTE)`;
