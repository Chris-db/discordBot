import dotenv from 'dotenv';
import path from 'path';

// ENV_FILE picks a different env file, so a second bot (a dev token invited to the
// throwaway test server only) can run from this checkout beside the Pi's copy without
// touching .env: `ENV_FILE=.env.dev npm run dev`.
dotenv.config({ path: process.env.ENV_FILE ?? '.env' });

export interface AppConfig {
  discordToken: string;
  clientId: string;
  guildId?: string;
  dbPath: string;
  defaultMmr: number;
  queueTimeoutMinutes: number;
  /** A match left IN_PROGRESS longer than this is auto-cancelled. Sized for a BO5. */
  matchTimeoutHours: number;
  /** A match stuck mid-setup (ready check / voting / drafting) longer than this is auto-cancelled. */
  setupTimeoutMinutes: number;
  /** How long a captain has to make a pick before it is auto-picked for them. */
  draftPickTimeoutSeconds: number;
  /**
   * Queue cooldown for a player who misses or leaves a ready check. 0 disables it.
   * Chris chose 5 minutes on 2026-09-11: enough to stop click-and-vanish without punishing
   * a genuine disconnect, and short enough that an admin never has to lift it.
   */
  afkCooldownMinutes: number;
  /** How long a popped lobby has to get everyone into the ready-check voice channel. */
  readyCheckTimeoutSeconds: number;
  /** Nightly SQLite snapshots. The database holds every rank and is not in version control. */
  backupEnabled: boolean;
  backupDir: string;
  backupRetentionDays: number;
  /** How long each setup vote (mode, captains, teams) stays open before silence decides it. */
  voteTimeoutSeconds: number;
  /**
   * Uptime heartbeat: a URL the bot pings while its gateway is connected, for a monitor
   * that alerts when the pings stop (Healthchecks.io etc). Unset = no heartbeat.
   */
  heartbeatUrl?: string;
  heartbeatIntervalMinutes: number;
  /**
   * GitHub Issues as the bot's outbox: every distinct runtime error and every `/feedback`
   * becomes an issue in this repo, for a person or an agent to pick up without needing a
   * way into the Pi. Both unset = nothing is sent. Token: fine-grained PAT, this repo only,
   * Issues read+write.
   */
  githubRepo?: string;
  githubToken?: string;
  /** Minimum minutes between two notes about the same error on its issue. */
  errorReportCooldownMinutes: number;
  /**
   * Servers where `/queue fill-bots` and `force-pop` may run. The test bots get real player
   * rows, so a fill in a live server leaves fake names on its leaderboard; that happened in
   * "6mans server" on 2026-11-07. Unset means no server allows them.
   */
  testGuildIds: string[];
}

/** A comma-separated list of ids, with blanks and spaces ignored. */
export function parseIdList(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map(id => id.trim()).filter(id => id.length > 0);
}

const config: AppConfig = {
  discordToken: process.env.DISCORD_TOKEN || '',
  clientId: process.env.CLIENT_ID || '',
  guildId: process.env.GUILD_ID,
  dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', '6mans.sqlite'),
  defaultMmr: parseInt(process.env.DEFAULT_MMR || '1000', 10),
  queueTimeoutMinutes: parseInt(process.env.QUEUE_TIMEOUT_MINUTES || '30', 10),
  matchTimeoutHours: parseInt(process.env.MATCH_TIMEOUT_HOURS || '3', 10),
  setupTimeoutMinutes: parseInt(process.env.SETUP_TIMEOUT_MINUTES || '15', 10),
  draftPickTimeoutSeconds: parseInt(process.env.DRAFT_PICK_TIMEOUT_SECONDS || '90', 10),
  readyCheckTimeoutSeconds: parseInt(process.env.READY_CHECK_TIMEOUT_SECONDS || '300', 10),
  afkCooldownMinutes: parseInt(process.env.AFK_COOLDOWN_MINUTES || '5', 10),
  backupEnabled: (process.env.BACKUP_ENABLED || 'true').toLowerCase() !== 'false',
  backupDir: process.env.BACKUP_DIR || path.join('data', 'backups'),
  backupRetentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10),
  voteTimeoutSeconds: parseInt(process.env.VOTE_TIMEOUT_SECONDS || '60', 10),
  heartbeatUrl: process.env.HEARTBEAT_URL || undefined,
  heartbeatIntervalMinutes: parseInt(process.env.HEARTBEAT_INTERVAL_MINUTES || '5', 10),
  githubRepo: process.env.GITHUB_REPO || undefined,
  githubToken: process.env.GITHUB_TOKEN || undefined,
  errorReportCooldownMinutes: parseInt(process.env.ERROR_REPORT_COOLDOWN_MINUTES || '60', 10),
  testGuildIds: parseIdList(process.env.TEST_GUILD_IDS),
};

export default config;

/** Whether the test-bot commands may run in this server. */
export function isTestGuild(guildId: string, c: AppConfig = config): boolean {
  return c.testGuildIds.includes(guildId);
}

/**
 * Everything that would otherwise fail later, and quietly. An empty token used to leave
 * the process idling with a warning, which under systemd looks exactly like a bot that is
 * up; a bad number in `.env` parsed to NaN and turned every timeout into "never".
 * Returns the problems rather than throwing so the caller decides how loud to be.
 */
export function validateConfig(c: AppConfig = config): string[] {
  const problems: string[] = [];
  if (!c.discordToken) problems.push('DISCORD_TOKEN is not set.');
  if (!c.clientId) problems.push('CLIENT_ID is not set (needed to register slash commands).');

  const positive: Array<[keyof AppConfig, string]> = [
    ['defaultMmr', 'DEFAULT_MMR'],
    ['queueTimeoutMinutes', 'QUEUE_TIMEOUT_MINUTES'],
    ['matchTimeoutHours', 'MATCH_TIMEOUT_HOURS'],
    ['setupTimeoutMinutes', 'SETUP_TIMEOUT_MINUTES'],
    ['draftPickTimeoutSeconds', 'DRAFT_PICK_TIMEOUT_SECONDS'],
    ['readyCheckTimeoutSeconds', 'READY_CHECK_TIMEOUT_SECONDS'],
    ['backupRetentionDays', 'BACKUP_RETENTION_DAYS'],
    ['voteTimeoutSeconds', 'VOTE_TIMEOUT_SECONDS'],
    ['heartbeatIntervalMinutes', 'HEARTBEAT_INTERVAL_MINUTES'],
    ['errorReportCooldownMinutes', 'ERROR_REPORT_COOLDOWN_MINUTES'],
  ];
  for (const [key, envName] of positive) {
    const value = c[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      problems.push(`${envName} must be a positive whole number (got "${process.env[envName]}").`);
    }
  }
  // Zero is a valid setting here: it means 'no cooldown'.
  if (!Number.isFinite(c.afkCooldownMinutes) || c.afkCooldownMinutes < 0) {
    problems.push(`AFK_COOLDOWN_MINUTES must be a whole number, 0 or more (got "${process.env.AFK_COOLDOWN_MINUTES}").`);
  }
  // A mistyped heartbeat URL would fail silently on every tick, and the monitor would
  // page for a bot that is perfectly fine.
  if (c.heartbeatUrl !== undefined && !/^https?:\/\/\S+$/.test(c.heartbeatUrl)) {
    problems.push(`HEARTBEAT_URL must be an http(s) URL (got "${c.heartbeatUrl}").`);
  }
  // Half a GitHub setup is the worst kind: the reporter would fail on every error and the
  // errors would go nowhere. Either both, or neither.
  if (Boolean(c.githubRepo) !== Boolean(c.githubToken)) {
    problems.push('GITHUB_REPO and GITHUB_TOKEN must be set together (or both left unset).');
  }
  if (c.githubRepo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(c.githubRepo)) {
    problems.push(`GITHUB_REPO must look like owner/name (got "${c.githubRepo}").`);
  }
  return problems;
}
