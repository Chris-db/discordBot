import db from './db';
import { logger } from '../utils/logger';

export function initializeDatabase(): void {
  const schemaSql = `
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
      text_channel_id TEXT,
      queue_channel_id TEXT,
      feed_channel_id TEXT,
      feed_message_id TEXT,
      winner TEXT DEFAULT 'NONE',
      report_status TEXT DEFAULT '{}',
      gamble_status TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      started_at TEXT
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
  `;

  db.exec(schemaSql);

  // Safe migrations for existing SQLite database files
  try {
    db.exec(`ALTER TABLE active_queues ADD COLUMN ready_check_vc_id TEXT;`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE active_queues ADD COLUMN captain_vote_state TEXT;`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE active_queues ADD COLUMN team_vote_state TEXT;`);
  } catch {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE active_queues ADD COLUMN player_join_times TEXT;`);
  } catch {
    // Column already exists
  }
  const newCols = ['text_channel_id', 'queue_channel_id', 'feed_channel_id', 'feed_message_id', 'gamble_status', 'started_at'];
  for (const col of newCols) {
    try {
      db.exec(`ALTER TABLE matches ADD COLUMN ${col} TEXT;`);
    } catch {
      // Column already exists
    }
  }

  logger.info('SQLite schema initialized successfully.');
}
