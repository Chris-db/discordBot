import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  runMigrations,
  columnExists,
  tableExists,
  divisionForLegacyMmr,
  DIVISIONS,
} from '../src/database/migrations';

/**
 * These run against a throwaway file rather than the shared test database, because the
 * thing under test is what happens to a database that already has data in it.
 */
let dbPath: string;
let db: Database.Database;

/** Recreates the pre-Phase-2 schema, exactly as an existing 6mans.sqlite looks. */
function createLegacyDatabase(target: Database.Database) {
  target.exec(`
    CREATE TABLE players (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      mmr INTEGER NOT NULL DEFAULT 1000,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE active_queues (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      message_id TEXT,
      player_ids TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'WAITING',
      vote_counts TEXT NOT NULL DEFAULT '{}',
      draft_state TEXT,
      ready_check_vc_id TEXT,
      player_join_times TEXT
    );
    CREATE TABLE matches (
      match_id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'IN_PROGRESS',
      blue_team TEXT NOT NULL,
      orange_team TEXT NOT NULL,
      rl_name TEXT NOT NULL,
      rl_pass TEXT NOT NULL,
      blue_voice_id TEXT,
      orange_voice_id TEXT,
      message_id TEXT,
      winner TEXT DEFAULT 'NONE',
      report_status TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );
    CREATE TABLE bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      banned_by TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'No reason provided',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/** One player per division band, so the backfill is exercised across the whole ladder. */
const LEGACY_PLAYERS = [
  { discord_id: 'p_c', username: 'CeeLo', mmr: 1050, wins: 3, losses: 7, streak: -2, division: 'C' },
  { discord_id: 'p_b', username: 'Bravo', mmr: 1250, wins: 10, losses: 8, streak: 1, division: 'B' },
  { discord_id: 'p_a', username: 'Alpha', mmr: 1450, wins: 20, losses: 10, streak: 4, division: 'A' },
  { discord_id: 'p_x', username: 'Xray', mmr: 1650, wins: 30, losses: 12, streak: 0, division: 'X' },
  { discord_id: 'p_s', username: 'Sierra', mmr: 1900, wins: 50, losses: 15, streak: 7, division: 'S' },
  { discord_id: 'p_edge', username: 'Edge', mmr: 1200, wins: 1, losses: 1, streak: 0, division: 'B' },
];

function seedLegacyPlayers(target: Database.Database) {
  const insert = target.prepare(
    'INSERT INTO players (discord_id, username, mmr, wins, losses, streak) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const p of LEGACY_PLAYERS) {
    insert.run(p.discord_id, p.username, p.mmr, p.wins, p.losses, p.streak);
  }
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `6mans_migration_${process.pid}_${Date.now()}_${Math.random()}.sqlite`);
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('schema migrations', () => {
  it('creates a full schema on an empty database', () => {
    const applied = runMigrations(db, { defaultGuildId: 'guild_1' });
    expect(applied).toBeGreaterThan(0);

    for (const table of [
      'players',
      'active_queues',
      'matches',
      'bans',
      'guild_divisions',
      'guild_config',
      'seasons',
      'season_snapshots',
      'schema_migrations',
    ]) {
      expect(tableExists(db, table), `${table} should exist`).toBe(true);
    }
  });

  it('is idempotent -- a second run applies nothing', () => {
    expect(runMigrations(db, { defaultGuildId: 'guild_1' })).toBeGreaterThan(0);
    expect(runMigrations(db, { defaultGuildId: 'guild_1' })).toBe(0);
    expect(runMigrations(db, { defaultGuildId: 'guild_1' })).toBe(0);
  });

  describe('upgrading an existing single-tenant database', () => {
    beforeEach(() => {
      createLegacyDatabase(db);
      seedLegacyPlayers(db);
      db.prepare(
        `INSERT INTO matches (guild_id, channel_id, state, blue_team, orange_team, rl_name, rl_pass, winner)
         VALUES ('guild_1', 'chan_1', 'COMPLETED', '["p_a"]', '["p_b"]', 'RL42', '317', 'BLUE')`
      ).run();
    });

    it('keeps every player and their stats', () => {
      runMigrations(db, { defaultGuildId: 'guild_1' });

      const rows = db.prepare('SELECT * FROM players ORDER BY discord_id').all() as any[];
      expect(rows.length).toBe(LEGACY_PLAYERS.length);

      for (const original of LEGACY_PLAYERS) {
        const migrated = rows.find(r => r.discord_id === original.discord_id);
        expect(migrated, `${original.discord_id} survived`).toBeDefined();
        expect(migrated.username).toBe(original.username);
        expect(migrated.mmr).toBe(original.mmr);
        expect(migrated.wins).toBe(original.wins);
        expect(migrated.losses).toBe(original.losses);
        expect(migrated.streak).toBe(original.streak);
        expect(migrated.guild_id).toBe('guild_1');
      }
    });

    it('places everyone in the division their old MMR already showed', () => {
      runMigrations(db, { defaultGuildId: 'guild_1' });

      for (const original of LEGACY_PLAYERS) {
        const row = db
          .prepare('SELECT division FROM players WHERE guild_id = ? AND discord_id = ?')
          .get('guild_1', original.discord_id) as { division: string };
        expect(row.division, `${original.username} (${original.mmr} MMR)`).toBe(original.division);
      }
    });

    it('marks grandfathered players as already placed', () => {
      runMigrations(db, { defaultGuildId: 'guild_1' });
      const unplaced = db.prepare('SELECT COUNT(*) AS n FROM players WHERE placed = 0').get() as {
        n: number;
      };
      expect(unplaced.n).toBe(0);
    });

    it('changes the primary key to (guild_id, discord_id)', () => {
      runMigrations(db, { defaultGuildId: 'guild_1' });

      // The same discord id in two guilds must be two independent rows with separate MMR.
      db.prepare(
        `INSERT INTO players (guild_id, discord_id, username, division, mmr) VALUES (?, ?, ?, ?, ?)`
      ).run('guild_2', 'p_a', 'Alpha', 'C', 1000);

      const rows = db.prepare('SELECT * FROM players WHERE discord_id = ?').all('p_a') as any[];
      expect(rows.length).toBe(2);
      expect(rows.find(r => r.guild_id === 'guild_1').mmr).toBe(1450);
      expect(rows.find(r => r.guild_id === 'guild_2').mmr).toBe(1000);
    });

    it('seeds the division ladder and an opening season for the guild', () => {
      runMigrations(db, { defaultGuildId: 'guild_1' });

      const divisions = db
        .prepare('SELECT * FROM guild_divisions WHERE guild_id = ? ORDER BY sort_order')
        .all('guild_1') as any[];
      expect(divisions.map(d => d.division)).toEqual(['C', 'B', 'A', 'X', 'S']);
      expect(divisions.map(d => d.default_mmr)).toEqual(DIVISIONS.map(d => d.defaultMmr));

      const season = db
        .prepare('SELECT * FROM seasons WHERE guild_id = ? AND is_active = 1')
        .get('guild_1') as any;
      expect(season).toBeDefined();
      expect(season.name).toBe('Season 1');
    });

    it('adds season_id and division to matches without touching existing rows', () => {
      runMigrations(db, { defaultGuildId: 'guild_1' });

      expect(columnExists(db, 'matches', 'season_id')).toBe(true);
      expect(columnExists(db, 'matches', 'division')).toBe(true);

      const match = db.prepare('SELECT * FROM matches WHERE match_id = 1').get() as any;
      expect(match.winner).toBe('BLUE');
      expect(match.blue_team).toBe('["p_a"]');
    });

    it('refuses to migrate players when there is no guild to assign them to', () => {
      // Losing the guild id would silently orphan every rank in the file.
      expect(() => runMigrations(db, {})).toThrow(/GUILD_ID/);

      // ...and the failed migration must not have half-applied.
      expect(columnExists(db, 'players', 'guild_id')).toBe(false);
      const count = db.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number };
      expect(count.n).toBe(LEGACY_PLAYERS.length);
    });

    it('leaves no foreign key violations behind', () => {
      runMigrations(db, { defaultGuildId: 'guild_1' });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });

    it('restores the foreign_keys pragma afterwards', () => {
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      runMigrations(db, { defaultGuildId: 'guild_1' });
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });
  });

  describe('divisionForLegacyMmr', () => {
    it('reproduces the old getRankTier bands exactly', () => {
      expect(divisionForLegacyMmr(0)).toBe('C');
      expect(divisionForLegacyMmr(1199)).toBe('C');
      expect(divisionForLegacyMmr(1200)).toBe('B');
      expect(divisionForLegacyMmr(1399)).toBe('B');
      expect(divisionForLegacyMmr(1400)).toBe('A');
      expect(divisionForLegacyMmr(1599)).toBe('A');
      expect(divisionForLegacyMmr(1600)).toBe('X');
      expect(divisionForLegacyMmr(1799)).toBe('X');
      expect(divisionForLegacyMmr(1800)).toBe('S');
      expect(divisionForLegacyMmr(9999)).toBe('S');
    });
  });
});
