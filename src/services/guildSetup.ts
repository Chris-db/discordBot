import db from '../database/db';
import { seedGuildDefaults } from '../database/migrations';
import { logger } from '../utils/logger';

/**
 * Gives a guild its default divisions, config row and first season.
 *
 * Migration 2 seeded these for every guild that existed when it ran, and nothing seeded
 * a guild that joined afterwards -- so the first test server had no divisions at all:
 * `/queue panel division:C` updated a row that did not exist, the panel posted with the
 * unregistered look, and placement, promotion and the join gate were all inert. Called
 * on boot for every guild the bot is in and again when it is invited somewhere new. The
 * seed is INSERT OR IGNORE throughout, so calling it for a guild that already has its
 * rows changes nothing.
 */
export function ensureGuildDefaults(guildId: string): boolean {
  const before = (
    db.prepare('SELECT COUNT(*) AS n FROM guild_divisions WHERE guild_id = ?').get(guildId) as { n: number }
  ).n;
  seedGuildDefaults(db, guildId);
  if (before === 0) {
    logger.info(`Guild ${guildId}: seeded default divisions, config and Season 1.`);
    return true;
  }
  return false;
}
