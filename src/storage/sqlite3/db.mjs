import sqlite3 from 'sqlite3'
import { open } from 'sqlite'

if (process.env.NODE_ENV === 'development') {
  sqlite3.verbose();
}

const db = await open({
  filename: '/tmp/database.db',
  driver: sqlite3.Database
});

export default db;
