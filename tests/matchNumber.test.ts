import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import db from '../src/database/db';
import { runMigrations } from '../src/database/migrations';
import { seedGuildDefaults } from '../src/database/migrations';
import { createMatch, getMatch, getMatchByNumber } from '../src/database/queries';

/**
 * Per-server match numbers.
 *
 * match_id is one AUTOINCREMENT sequence across every server, so the first match on a
 * trial server would have been "#47". match_number counts from 1 per guild and is what
 * every human-facing surface shows; match_id stays the key.
 */

const newMatch = (guildId: string) =>
  createMatch({
    guild_id: guildId,
    channel_id: `chan_${guildId}`,
    team_size: 3,
    blue_team: ['b1', 'b2', 'b3'],
    orange_team: ['o1', 'o2', 'o3'],
  });

describe('per-guild match numbers', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM matches').run();
    seedGuildDefaults(db, 'guild_a');
    seedGuildDefaults(db, 'guild_b');
  });

  it('numbers each guild from 1, independently of the global match_id', () => {
    const a1 = newMatch('guild_a');
    const a2 = newMatch('guild_a');
    const b1 = newMatch('guild_b');
    const a3 = newMatch('guild_a');

    expect([a1, a2, a3].map(m => m.match_number)).toEqual([1, 2, 3]);
    expect(b1.match_number).toBe(1);

    // The key keeps counting globally, so the two are genuinely different columns.
    expect(b1.match_id).toBeGreaterThan(a2.match_id);
    expect(a3.match_id).toBeGreaterThan(b1.match_id);
  });

  it('carries on after a cancelled match rather than reusing its number', () => {
    const first = newMatch('guild_a');
    db.prepare("UPDATE matches SET state = 'CANCELLED' WHERE match_id = ?").run(first.match_id);
    expect(newMatch('guild_a').match_number).toBe(2);
  });

  it('resolves a number inside its own guild only', () => {
    const a1 = newMatch('guild_a');
    newMatch('guild_a');
    const b1 = newMatch('guild_b');

    expect(getMatchByNumber('guild_a', 1)?.match_id).toBe(a1.match_id);
    expect(getMatchByNumber('guild_b', 1)?.match_id).toBe(b1.match_id);
    // Guild B has one match; asking for its #2 must not leak guild A's.
    expect(getMatchByNumber('guild_b', 2)).toBeUndefined();
    expect(getMatch(a1.match_id)?.match_number).toBe(1);
  });

  it('refuses two rows with the same number in one guild', () => {
    const a1 = newMatch('guild_a');
    expect(() =>
      db
        .prepare(
          `INSERT INTO matches (guild_id, match_number, channel_id, team_size, blue_team, orange_team, rl_name, rl_pass)
           VALUES ('guild_a', ?, 'c', 3, '[]', '[]', '', '')`
        )
        .run(a1.match_number)
    ).toThrow(/UNIQUE/);
  });
});

describe('migration 6 backfill', () => {
  let filePath: string;
  let raw: Database.Database;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `6mans_matchnum_${process.pid}_${Date.now()}_${Math.random()}.sqlite`);
    raw = new Database(filePath);
  });

  const cleanup = () => {
    raw.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(filePath + suffix)) fs.unlinkSync(filePath + suffix);
    }
  };

  it('numbers existing matches per guild in match_id order, then keeps counting', () => {
    // Everything up to migration 5, as the Pi's database looks the morning of the deploy.
    const before6 = runMigrations(raw, { defaultGuildId: 'guild_1' });
    expect(before6).toBeGreaterThanOrEqual(6);

    // Roll migration 6 back by hand so the file looks like the live one: no column, no
    // index, no record of version 6. Then play some matches "before the deploy".
    raw.exec(`
      DELETE FROM schema_migrations WHERE version = 6;
      DROP INDEX IF EXISTS idx_matches_guild_number;
      ALTER TABLE matches DROP COLUMN match_number;
    `);
    const insert = raw.prepare(
      `INSERT INTO matches (guild_id, channel_id, team_size, state, blue_team, orange_team, rl_name, rl_pass)
       VALUES (?, 'c', 3, 'COMPLETED', '[]', '[]', '', '')`
    );
    // Interleaved so the backfill has to partition by guild rather than just rank rows.
    for (const g of ['guild_1', 'guild_1', 'guild_2', 'guild_1', 'guild_2']) insert.run(g);

    expect(runMigrations(raw, { defaultGuildId: 'guild_1' })).toBe(1);

    const rows = raw
      .prepare('SELECT match_id, guild_id, match_number FROM matches ORDER BY match_id')
      .all() as { match_id: number; guild_id: string; match_number: number }[];
    expect(rows.map(r => `${r.guild_id}#${r.match_number}`)).toEqual([
      'guild_1#1',
      'guild_1#2',
      'guild_2#1',
      'guild_1#3',
      'guild_2#2',
    ]);

    // The unique index is back, so a duplicate is refused.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO matches (guild_id, match_number, channel_id, team_size, blue_team, orange_team, rl_name, rl_pass)
           VALUES ('guild_1', 3, 'c', 3, '[]', '[]', '', '')`
        )
        .run()
    ).toThrow(/UNIQUE/);

    cleanup();
  });

  it('leaves a database with no matches alone', () => {
    runMigrations(raw, { defaultGuildId: 'guild_1' });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM matches').get()).toEqual({ n: 0 });
    cleanup();
  });
});
