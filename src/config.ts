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
};

export default config;
