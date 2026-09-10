import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

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
  /** How long a popped lobby has to get everyone into the ready-check voice channel. */
  readyCheckTimeoutSeconds: number;
  /** Nightly SQLite snapshots. The database holds every rank and is not in version control. */
  backupEnabled: boolean;
  backupDir: string;
  backupRetentionDays: number;
  /** How long each setup vote (mode, captains, teams) stays open before silence decides it. */
  voteTimeoutSeconds: number;
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
  backupEnabled: (process.env.BACKUP_ENABLED || 'true').toLowerCase() !== 'false',
  backupDir: process.env.BACKUP_DIR || path.join('data', 'backups'),
  backupRetentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10),
  voteTimeoutSeconds: parseInt(process.env.VOTE_TIMEOUT_SECONDS || '60', 10),
};

export default config;

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
  ];
  for (const [key, envName] of positive) {
    const value = c[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      problems.push(`${envName} must be a positive whole number (got "${process.env[envName]}").`);
    }
  }
  return problems;
}
