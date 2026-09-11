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
 * The team sizes the bot can run a queue at, and the one everything played before
 * multi-queue existed.
 *
 * A "ladder" is a (guild_id, team_size) pair: each size has its own MMR, W/L, division
 * placement and leaderboard, so being Rank A at 3v3 says nothing about your 2v2.
 */
export const SUPPORTED_TEAM_SIZES = [2, 3, 4] as const;
export const DEFAULT_TEAM_SIZE = 3;

export type TeamSize = (typeof SUPPORTED_TEAM_SIZES)[number];

export function isSupportedTeamSize(size: number): size is TeamSize {
  return (SUPPORTED_TEAM_SIZES as readonly number[]).includes(size);
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
        seedGuildDefaultsV2(db, guildId);
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
  {
    version: 4,
    name: 'per-size ladders: split player identity from stats, team_size everywhere',
    up: db => {
      // ---- players: identity | player_ladders: one row per size ------------------------
      //
      // players mixed identity (username) with ladder stats (mmr, division, W/L). Giving
      // every size its own stats would have meant three rows per player each carrying its
      // own copy of the username -- and getOrCreatePlayer refreshes the username on rename
      // against a single row, so a renamed player would keep the stale name on whichever
      // sizes they had not played since. Splitting the table makes a rename one update.
      if (!tableExists(db, 'player_ladders')) {
        db.exec(`
          CREATE TABLE player_ladders (
            guild_id TEXT NOT NULL,
            discord_id TEXT NOT NULL,
            team_size INTEGER NOT NULL,
            division TEXT NOT NULL DEFAULT 'C',
            mmr INTEGER NOT NULL DEFAULT 1000,
            wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0,
            streak INTEGER NOT NULL DEFAULT 0,
            placed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (guild_id, discord_id, team_size)
          );
        `);

        // Every game played before this migration was 3v3, so that is the ladder the
        // existing MMR belongs to. The other sizes start empty and fill in lazily, exactly
        // as a brand-new player does today.
        db.prepare(
          `INSERT INTO player_ladders
             (guild_id, discord_id, team_size, division, mmr, wins, losses, streak, placed)
           SELECT guild_id, discord_id, ?, division, mmr, wins, losses, streak, placed
           FROM players`
        ).run(DEFAULT_TEAM_SIZE);

        const moved = (
          db.prepare('SELECT COUNT(*) AS n FROM player_ladders').get() as { n: number }
        ).n;

        db.exec(`
          CREATE TABLE players_v3 (
            guild_id TEXT NOT NULL,
            discord_id TEXT NOT NULL,
            username TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, discord_id)
          );

          INSERT INTO players_v3 (guild_id, discord_id, username, created_at)
            SELECT guild_id, discord_id, username, created_at FROM players;

          DROP TABLE players;
          ALTER TABLE players_v3 RENAME TO players;

          CREATE INDEX IF NOT EXISTS idx_player_ladders_leaderboard
            ON player_ladders(guild_id, team_size, division, mmr DESC);
        `);

        logger.info(`Migration 4: moved ${moved} player(s) onto the ${DEFAULT_TEAM_SIZE}v${DEFAULT_TEAM_SIZE} ladder.`);
      }

      // ---- guild_divisions: one ladder configuration per size --------------------------
      //
      // queue_channel_id lives here, so widening the key to include team_size is what makes
      // a queue channel resolve to exactly one (division, size) -- which is both the queue's
      // size setting and the ladder its results count towards.
      if (!columnExists(db, 'guild_divisions', 'team_size')) {
        db.prepare(
          `CREATE TABLE guild_divisions_v2 (
            guild_id TEXT NOT NULL,
            team_size INTEGER NOT NULL,
            division TEXT NOT NULL,
            display_name TEXT NOT NULL,
            default_mmr INTEGER NOT NULL,
            promote_at INTEGER,
            relegate_below INTEGER,
            queue_channel_id TEXT,
            role_id TEXT,
            sort_order INTEGER NOT NULL,
            PRIMARY KEY (guild_id, team_size, division)
          )`
        ).run();

        db.prepare(
          `INSERT INTO guild_divisions_v2
             (guild_id, team_size, division, display_name, default_mmr, promote_at,
              relegate_below, queue_channel_id, role_id, sort_order)
           SELECT guild_id, ?, division, display_name, default_mmr, promote_at,
                  relegate_below, queue_channel_id, role_id, sort_order
           FROM guild_divisions`
        ).run(DEFAULT_TEAM_SIZE);

        db.exec(`
          DROP TABLE guild_divisions;
          ALTER TABLE guild_divisions_v2 RENAME TO guild_divisions;
          CREATE INDEX IF NOT EXISTS idx_guild_divisions_channel
            ON guild_divisions(queue_channel_id);
        `);

        // Give every guild that already has a ladder the other sizes too, unconfigured.
        // An admin points a channel at one with /queue panel or /division configure.
        const guildIds = (
          db.prepare('SELECT DISTINCT guild_id FROM guild_divisions').all() as { guild_id: string }[]
        ).map(r => r.guild_id);
        for (const guildId of guildIds) {
          for (const size of SUPPORTED_TEAM_SIZES) {
            if (size === DEFAULT_TEAM_SIZE) continue;
            seedDivisionLadder(db, guildId, size);
          }
        }
      }

      // ---- team_size on the rows that describe a single game ---------------------------
      addColumnIfMissing(
        db,
        'active_queues',
        'team_size',
        `INTEGER NOT NULL DEFAULT ${DEFAULT_TEAM_SIZE}`
      );
      addColumnIfMissing(db, 'matches', 'team_size', 'INTEGER');
      db.prepare('UPDATE matches SET team_size = ? WHERE team_size IS NULL').run(DEFAULT_TEAM_SIZE);
      addColumnIfMissing(
        db,
        'season_snapshots',
        'team_size',
        `INTEGER NOT NULL DEFAULT ${DEFAULT_TEAM_SIZE}`
      );

      // A season snapshot is now ranked within (size, division), not division alone.
      db.exec(`
        DROP INDEX IF EXISTS idx_season_snapshots_season;
        CREATE INDEX IF NOT EXISTS idx_season_snapshots_season
          ON season_snapshots(season_id, team_size, division, final_rank);
        CREATE INDEX IF NOT EXISTS idx_matches_guild_size
          ON matches(guild_id, team_size, state);
      `);
    },
  },
  {
    version: 5,
    name: 'per-guild themes',
    up: db => {
      // Colour overrides for the image cards, as a JSON map of palette token -> hex.
      // Only the overrides are stored, so a default that changes in code still applies
      // to every server that has not touched that token.
      db.exec(`
        CREATE TABLE IF NOT EXISTS guild_themes (
          guild_id TEXT PRIMARY KEY,
          theme TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
  {
    version: 6,
    name: 'per-guild match numbers',
    up: db => {
      // match_id is one AUTOINCREMENT sequence across every server, so a second server's
      // first match would be "Match #47". match_number counts from 1 per guild and is
      // what every human-facing surface shows (channel names, cards, embeds, /match
      // list). match_id stays the key: foreign references, timers and the admin
      // commands all resolve a number back to it.
      addColumnIfMissing(db, 'matches', 'match_number', 'INTEGER');
      db.exec(`
        UPDATE matches SET match_number = (
          SELECT COUNT(*) FROM matches AS earlier
          WHERE earlier.guild_id = matches.guild_id AND earlier.match_id <= matches.match_id
        )
        WHERE match_number IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_guild_number
          ON matches(guild_id, match_number);
      `);
    },
  },
];

/**
 * Migration 2's seeding, frozen at the schema of the day.
 *
 * Migration 4 adds team_size to guild_divisions' primary key. A migration has to keep
 * producing the same result forever, so it cannot call the shared seeder -- that one now
 * writes a column this table does not have yet at version 2.
 */
function seedGuildDefaultsV2(db: Database, guildId: string): void {
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

  seedGuildConfigAndSeason(db, guildId);
}

/** The standard five-division ladder for one (guild, size). Leaves admin edits alone. */
export function seedDivisionLadder(db: Database, guildId: string, teamSize: number): void {
  const insertDivision = db.prepare(`
    INSERT OR IGNORE INTO guild_divisions
      (guild_id, team_size, division, display_name, default_mmr, promote_at, relegate_below, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const d of DIVISIONS) {
    insertDivision.run(
      guildId,
      teamSize,
      d.division,
      d.displayName,
      d.defaultMmr,
      d.promoteAt,
      d.relegateBelow,
      d.sortOrder
    );
  }
}

function seedGuildConfigAndSeason(db: Database, guildId: string): void {
  db.prepare('INSERT OR IGNORE INTO guild_config (guild_id) VALUES (?)').run(guildId);

  // One season spans every size: ending it resets all three ladders together.
  const activeSeason = db
    .prepare('SELECT season_id FROM seasons WHERE guild_id = ? AND is_active = 1')
    .get(guildId);
  if (!activeSeason) {
    db.prepare('INSERT INTO seasons (guild_id, name) VALUES (?, ?)').run(guildId, 'Season 1');
  }
}

/**
 * Gives a guild the standard division ladder at every supported size, plus an open
 * season. Safe to re-run -- an admin's edits to thresholds or channel ids are left alone.
 */
export function seedGuildDefaults(db: Database, guildId: string): void {
  for (const size of SUPPORTED_TEAM_SIZES) {
    seedDivisionLadder(db, guildId, size);
  }
  seedGuildConfigAndSeason(db, guildId);
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
