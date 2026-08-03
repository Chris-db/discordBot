/**
 * Per-worker test database.
 *
 * Vitest runs test files in parallel workers, each with its own better-sqlite3 connection.
 * Pointing them all at one file means their `DELETE FROM ...` cleanups stomp each other and
 * WAL writers collide ("database is locked"). Give every worker its own file instead.
 *
 * This must run before anything imports src/database/db.ts, which opens the connection at
 * module load using the DB_PATH that config.ts read at *its* module load — hence the
 * dynamic import below rather than a top-level one.
 */
const workerId = process.env.VITEST_WORKER_ID ?? '0';
process.env.DB_PATH = `data/test_worker_${workerId}.sqlite`;

const { initializeDatabase } = await import('../src/database/schema');

// Files that only exercise pure logic still transitively import queries.ts (rlCredentials
// hits the matches table), so the schema has to exist before any test runs.
initializeDatabase();
