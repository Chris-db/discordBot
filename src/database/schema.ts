import db from './db';
import config from '../config';
import { runMigrations } from './migrations';
import { logger } from '../utils/logger';

export function initializeDatabase(): void {
  // Migrations are ordered, recorded in schema_migrations, and fatal on failure. They
  // replace a block of `try { ALTER TABLE } catch {}`, which silently swallowed real
  // errors -- tolerable for adding a nullable column, not for rebuilding the table that
  // holds every player's rank.
  const applied = runMigrations(db, { defaultGuildId: config.guildId });

  if (applied > 0) {
    logger.info(`SQLite schema initialized (${applied} migration(s) applied).`);
  } else {
    logger.info('SQLite schema initialized (already up to date).');
  }
}
