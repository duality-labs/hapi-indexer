import sqlite3 from 'sqlite3';
import { Database } from 'sqlite';
import { Sql } from 'sql-template-tag';

const { NODE_ENV, DB_FILENAME = '/tmp/database.db', WAL = '' } = process.env;

if (NODE_ENV === 'development') {
  sqlite3.verbose();
}

export const db = new Database({
  filename: DB_FILENAME,
  driver: sqlite3.Database,
});

export async function init() {
  await db.open();
  if (WAL) {
    // enable WAL mode (significantly faster for many frequent write to file)
    await db.exec('PRAGMA journal_mode=WAL;');
  }
}

export default db;

// format sql-template-tag objects into a format that node sqlite can accept
export function prepare(sql: Sql): [string, ...unknown[]] {
  return [sql.sql, ...sql.values];
}
