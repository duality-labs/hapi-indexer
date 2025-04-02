import { createClient } from '@clickhouse/client';

const {
  CLICKHOUSE_DB_HOST = '',
  CLICKHOUSE_DB_PORT = '',
  CLICKHOUSE_DB_USER = undefined,
  CLICKHOUSE_DB_NAME = undefined,
  CLICKHOUSE_DB_PASS = undefined,
} = process.env;

export const client = createClient({
  url: `${CLICKHOUSE_DB_HOST}:${CLICKHOUSE_DB_PORT}`,
  username: CLICKHOUSE_DB_USER,
  password: CLICKHOUSE_DB_PASS,
  database: CLICKHOUSE_DB_NAME,
  clickhouse_settings: {
    log_queries_min_query_duration_ms: 25,
    // log_query_threads: 1,
    // send_logs_level: 'trace',
  },
});
