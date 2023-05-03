import sqlite3 from 'sqlite3'
import { open } from 'sqlite'

if (process.env.NODE_ENV === 'development') {
  sqlite3.verbose();
}

export const dbPromise = open({
  filename: ':memory:',
  driver: sqlite3.Database
});

export default await dbPromise;
