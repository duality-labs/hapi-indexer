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
    // prevent this client from making any write requests
    readonly: '1',
  },
});
