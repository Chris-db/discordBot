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

// Without a busy timeout, a write that lands while the nightly backup holds the file
// throws SQLITE_BUSY immediately instead of waiting -- which would surface as a match
// report simply failing. NORMAL is the standard companion to WAL: still crash-safe,
// and it stops fsyncing on every single commit.
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

export default db;
