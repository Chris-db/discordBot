import type { Database } from 'better-sqlite3';
import { logger } from '../utils/logger';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database, ctx: MigrationContext) => void;
}

export interface MigrationContext {
  /**
   * The guild that existing single-tenant rows belong to. Needed only by the migration that
   * adds guild_id to players -- there is no way to derive it from a row that predates the
   * column.
   */
  defaultGuildId?: string;
}

/** True if `table` already has `column`. Replaces `try { ALTER } catch {}`. */
export function columnExists(db: Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some(c => c.name === column);
}

/** Adds a column only when it is genuinely missing, so real errors still throw. */
export function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  definition: string
): void {
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

export function tableExists(db: Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return !!row;
}

/**
 * The five rank divisions, in ascending order.
 *
 * Rank is stored state rather than a function of MMR, but the default MMR and the
 * promotion/relegation thresholds deliberately reproduce the MMR bands the old
 * getRankTier() used, so migrating an existing database does not visibly move anybody.
 */
export const DIVISIONS = [
  { division: 'C', displayName: 'Rank C', defaultMmr: 1000, promoteAt: 1200, relegateBelow: null, sortOrder: 1 },
  { division: 'B', displayName: 'Rank B', defaultMmr: 1300, promoteAt: 1400, relegateBelow: 1200, sortOrder: 2 },
  { division: 'A', displayName: 'Rank A', defaultMmr: 1500, promoteAt: 1600, relegateBelow: 1400, sortOrder: 3 },
  { division: 'X', displayName: 'Rank X', defaultMmr: 1700, promoteAt: 1800, relegateBelow: 1600, sortOrder: 4 },
  { division: 'S', displayName: 'Rank S', defaultMmr: 1900, promoteAt: null, relegateBelow: 1800, sortOrder: 5 },
] as const;

/** Places a pre-migration player into a division using the MMR bands that used to derive it. */
export function divisionForLegacyMmr(mmr: number): string {
  if (mmr >= 1800) return 'S';
  if (mmr >= 1600) return 'X';
  if (mmr >= 1400) return 'A';
  if (mmr >= 1200) return 'B';
  return 'C';
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'baseline',
    up: db => {
      // Idempotent: this is both the fresh-install schema and the "what an existing
      // database already looks like" marker, so it must be safe to run against both.
      db.exec(`
        CREATE TABLE IF NOT EXISTS players (
          discord_id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          mmr INTEGER NOT NULL DEFAULT 1000,
          wins INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0,
          streak INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS active_queues (
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

        CREATE TABLE IF NOT EXISTS matches (
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

        CREATE TABLE IF NOT EXISTS bans (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          discord_id TEXT NOT NULL,
          banned_by TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT 'No reason provided',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TEXT,
          revoked INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_players_mmr ON players(mmr DESC);
        CREATE INDEX IF NOT EXISTS idx_matches_state ON matches(state);
        CREATE INDEX IF NOT EXISTS idx_bans_player ON bans(discord_id, guild_id);
      `);

      // Columns added incrementally before this migration runner existed.
      addColumnIfMissing(db, 'active_queues', 'ready_check_vc_id', 'TEXT');
      addColumnIfMissing(db, 'active_queues', 'captain_vote_state', 'TEXT');
      addColumnIfMissing(db, 'active_queues', 'team_vote_state', 'TEXT');
      addColumnIfMissing(db, 'active_queues', 'player_join_times', 'TEXT');
      for (const col of [
        'text_channel_id',
        'queue_channel_id',
        'feed_channel_id',
        'feed_message_id',
        'gamble_status',
        'started_at',
        'ready_check_vc_id',
      ]) {
        addColumnIfMissing(db, 'matches', col, 'TEXT');
      }
    },
  },
  {
    version: 2,
    name: 'guild-scoped players, rank divisions, seasons, per-guild config',
    up: (db, ctx) => {
      // ---- players: (discord_id) -> (guild_id, discord_id), plus stored division -------
      //
      // discord_id was the primary key, so every server shared one MMR pool and one
      // leaderboard. SQLite cannot alter a primary key in place, so this is a table rebuild.
      if (!columnExists(db, 'players', 'guild_id')) {
        const orphanCount = ctx.defaultGuildId
          ? 0
          : (db.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number }).n;
        if (orphanCount > 0) {
          throw new Error(
            `Cannot add guild_id to ${orphanCount} existing players: no guild id available. ` +
              'Set GUILD_ID in .env to the server these ranks belong to and restart.'
          );
        }

        db.exec(`
          CREATE TABLE players_v2 (
            guild_id TEXT NOT NULL,
            discord_id TEXT NOT NULL,
            username TEXT NOT NULL,
            division TEXT NOT NULL DEFAULT 'C',
            mmr INTEGER NOT NULL DEFAULT 1000,
            wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0,
            streak INTEGER NOT NULL DEFAULT 0,
            placed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, discord_id)
          );
        `);

        if (ctx.defaultGuildId) {
          // Division is backfilled from the MMR bands getRankTier() used, so the rank
          // everyone already sees carries over unchanged. placed = 1 marks them as
          // grandfathered so admins are not asked to re-place the whole server by hand.
          const rows = db
            .prepare('SELECT discord_id, username, mmr, wins, losses, streak, created_at FROM players')
            .all() as {
            discord_id: string;
            username: string;
            mmr: number;
            wins: number;
            losses: number;
            streak: number;
            created_at: string;
          }[];

          const insert = db.prepare(`
            INSERT INTO players_v2
              (guild_id, discord_id, username, division, mmr, wins, losses, streak, placed, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
          `);
          for (const r of rows) {
            insert.run(
              ctx.defaultGuildId,
              r.discord_id,
              r.username,
              divisionForLegacyMmr(r.mmr),
              r.mmr,
              r.wins,
              r.losses,
              r.streak,
              r.created_at
            );
          }
          logger.info(`Migration 2: moved ${rows.length} players into guild ${ctx.defaultGuildId}.`);
        }

        db.exec(`
          DROP TABLE players;
          ALTER TABLE players_v2 RENAME TO players;
          CREATE INDEX IF NOT EXISTS idx_players_leaderboard
            ON players(guild_id, division, mmr DESC);
        `);
      }

      // ---- per-guild division configuration -------------------------------------------
      db.exec(`
        CREATE TABLE IF NOT EXISTS guild_divisions (
          guild_id TEXT NOT NULL,
          division TEXT NOT NULL,
          display_name TEXT NOT NULL,
          default_mmr INTEGER NOT NULL,
          promote_at INTEGER,
          relegate_below INTEGER,
          queue_channel_id TEXT,
          role_id TEXT,
          sort_order INTEGER NOT NULL,
          PRIMARY KEY (guild_id, division)
        );

        CREATE TABLE IF NOT EXISTS guild_config (
          guild_id TEXT PRIMARY KEY,
          feed_channel_id TEXT,
          match_category_id TEXT,
          mod_role_id TEXT,
          season_reset_enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // ---- seasons ---------------------------------------------------------------------
      db.exec(`
        CREATE TABLE IF NOT EXISTS seasons (
          season_id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          name TEXT NOT NULL,
          started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          ended_at TEXT,
          is_active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS season_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          season_id INTEGER NOT NULL,
          guild_id TEXT NOT NULL,
          discord_id TEXT NOT NULL,
          division TEXT NOT NULL,
          final_mmr INTEGER NOT NULL,
          final_wins INTEGER NOT NULL,
          final_losses INTEGER NOT NULL,
          final_rank INTEGER NOT NULL,
          outcome TEXT NOT NULL DEFAULT 'STAYED',
          FOREIGN KEY (season_id) REFERENCES seasons(season_id)
        );

        CREATE INDEX IF NOT EXISTS idx_seasons_guild ON seasons(guild_id, is_active);
        CREATE INDEX IF NOT EXISTS idx_season_snapshots_season
          ON season_snapshots(season_id, division, final_rank);
      `);

      addColumnIfMissing(db, 'matches', 'season_id', 'INTEGER');
      addColumnIfMissing(db, 'matches', 'division', 'TEXT');

      // ---- seed divisions + an opening season for guilds already in the database -------
      const guildIds = new Set<string>();
      if (ctx.defaultGuildId) guildIds.add(ctx.defaultGuildId);
      for (const row of db.prepare('SELECT DISTINCT guild_id FROM matches').all() as {
        guild_id: string;
      }[]) {
        if (row.guild_id) guildIds.add(row.guild_id);
      }
      for (const row of db.prepare('SELECT DISTINCT guild_id FROM active_queues').all() as {
        guild_id: string;
      }[]) {
        if (row.guild_id) guildIds.add(row.guild_id);
      }

      for (const guildId of guildIds) {
        seedGuildDefaults(db, guildId);
      }
    },
  },
  {
    version: 3,
    name: 'rematch series tracking',
    up: db => {
      // A rematch is a new match row sharing a series id with the one before it, so match
      // history stays one-row-per-game. series_game is the position within the series.
      addColumnIfMissing(db, 'matches', 'series_id', 'TEXT');
      addColumnIfMissing(db, 'matches', 'series_game', 'INTEGER');
      db.exec('CREATE INDEX IF NOT EXISTS idx_matches_series ON matches(series_id, series_game);');
    },
  },
];

/**
 * Gives a guild the standard division ladder and an open season. Safe to re-run -- an
 * admin's edits to thresholds or channel ids are left alone.
 */
export function seedGuildDefaults(db: Database, guildId: string): void {
  const insertDivision = db.prepare(`
    INSERT OR IGNORE INTO guild_divisions
      (guild_id, division, display_name, default_mmr, promote_at, relegate_below, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of DIVISIONS) {
    insertDivision.run(
      guildId,
      d.division,
      d.displayName,
      d.defaultMmr,
      d.promoteAt,
      d.relegateBelow,
      d.sortOrder
    );
  }

  db.prepare('INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)').run(guildId);

  const activeSeason = db
    .prepare('SELECT season_id FROM seasons WHERE guild_id = ? AND is_active = 1')
    .get(guildId);
  if (!activeSeason) {
    db.prepare('INSERT INTO seasons (guild_id, name) VALUES (?, ?)').run(guildId, 'Season 1');
  }
}

/**
 * Applies every pending migration in order, each in its own transaction.
 *
 * Unlike the `try { ALTER TABLE } catch {}` this replaces, a failure here is fatal: a
 * half-migrated ranks database is worse than a bot that refuses to start.
 */
export function runMigrations(db: Database, ctx: MigrationContext = {}): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      r => r.version
    )
  );

  const pending = migrations.filter(m => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return 0;

  // A table rebuild has to drop and recreate players; foreign_keys must be off for that,
  // and the pragma is a no-op inside a transaction.
  const foreignKeysWereOn = db.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysWereOn) db.pragma('foreign_keys = OFF');

  try {
    for (const migration of pending) {
      logger.info(`Applying migration ${migration.version}: ${migration.name}...`);
      db.transaction(() => {
        migration.up(db, ctx);
        db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
          migration.version,
          migration.name
        );
      })();
      logger.info(`Migration ${migration.version} applied.`);
    }

    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `Migration left ${violations.length} foreign key violation(s): ${JSON.stringify(violations)}`
      );
    }
  } finally {
    if (foreignKeysWereOn) db.pragma('foreign_keys = ON');
  }

  return pending.length;
}

export const allMigrations = migrations;
