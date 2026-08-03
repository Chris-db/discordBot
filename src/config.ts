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
}

const config: AppConfig = {
  discordToken: process.env.DISCORD_TOKEN || '',
  clientId: process.env.CLIENT_ID || '',
  guildId: process.env.GUILD_ID,
  dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', '6mans.sqlite'),
  defaultMmr: parseInt(process.env.DEFAULT_MMR || '1000', 10),
  queueTimeoutMinutes: parseInt(process.env.QUEUE_TIMEOUT_MINUTES || '30', 10),
};

export default config;
