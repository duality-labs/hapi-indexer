import Sqlite3 from 'sqlite3'

const sqlite3 = Sqlite3.verbose();
const db = new sqlite3.Database(':memory:');

export default db;
