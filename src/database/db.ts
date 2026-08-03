import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import config from '../config';

// Ensure the directory for SQLite exists
const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db: Database.Database = new Database(config.dbPath, {
  verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
});

// Enable WAL mode for high concurrency and performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export default db;
