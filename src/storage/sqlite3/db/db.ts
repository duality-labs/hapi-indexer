import sqlite3 from 'sqlite3';
import { Database } from 'sqlite';

import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'

const dialect = new SqliteDialect({
  database: new SQLite(':memory:'),
})


const { NODE_ENV, DB_FILENAME = '/tmp/database.db' } = process.env;

if (NODE_ENV === 'development') {
  sqlite3.verbose();
}

export const db = new Kysely({ dialect });

export default db;
