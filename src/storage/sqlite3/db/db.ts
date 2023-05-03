import sqlite3 from 'sqlite3'
import { open } from 'sqlite'

const { NODE_ENV, DB_FILENAME='/tmp/database.db' } = process.env;

if (NODE_ENV === 'development') {
  sqlite3.verbose();
}

export const dbPromise = open({
  filename: DB_FILENAME,
  driver: sqlite3.Database
});

export default await dbPromise;
