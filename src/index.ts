import {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
} from 'discord.js';
import config from './config';
import { initializeDatabase } from './database/schema';
import { handleCommand, registerCommands } from './handlers/commandHandler';
import { handleInteraction } from './handlers/interactionHandler';
import {
  handleChannelMessage,
  checkQueueTimeouts,
  sweepStaleMatches,
  recoverStuckQueues,
} from './services/queueService';
import { startBackupSchedule } from './services/backupService';
import { logger } from './utils/logger';
import db from './database/db';

// Initialize SQLite database schema
initializeDatabase();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async readyClient => {
  logger.info(`🚀 Logged in as ${readyClient.user.tag}! Rocket League 6mans bot is online.`);

  readyClient.user.setActivity('Rocket League 6mans (/queue panel)', {
    type: ActivityType.Playing,
  });

  // Optionally auto-register commands on boot if token is present
  if (config.discordToken && config.clientId) {
    await registerCommands();
  }

  // Recover any queues left in temporary states from before a crash/restart
  recoverStuckQueues(readyClient).catch(err => {
    logger.error('Error recovering stuck queues:', err);
  });

  // Periodically check every 60 seconds for players inactive in queue > 30 minutes
  setInterval(() => {
    checkQueueTimeouts(readyClient).catch(err => {
      logger.error('Error checking queue timeouts:', err);
    });
  }, 60_000);

  // Every 5 minutes, release matches that have been abandoned mid-flight. Without this a
  // match that nobody reports keeps all 6 of its players locked out of the queue forever.
  setInterval(() => {
    sweepStaleMatches(readyClient).catch(err => {
      logger.error('Error sweeping stale matches:', err);
    });
  }, 5 * 60_000);

  // Nightly database snapshots. data/6mans.sqlite holds every player's rank and history and
  // is (correctly) not in version control, so this is the only thing standing between a disk
  // failure and losing the season.
  startBackupSchedule();

  // Checkpoint SQLite WAL every 30 minutes to maintain small WAL file sizes
  setInterval(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      logger.error('Error checkpointing SQLite WAL:', err);
    }
  }, 30 * 60_000);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
      await handleInteraction(interaction);
    }
  } catch (error) {
    logger.error('Unhandled interaction error:', error);
  }
});

client.on(Events.MessageCreate, message => {
  try {
    handleChannelMessage(client, message);
  } catch (error) {
    logger.error('Error handling channel message:', error);
  }
});

// Process error handlers so bot never crashes ungracefully
process.on('unhandledRejection', error => {
  logger.error('Unhandled Rejection:', error);
});

process.on('uncaughtException', error => {
  logger.error('Uncaught Exception:', error);
});

// Graceful shutdown handling for SIGINT and SIGTERM
function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  try {
    client.destroy();
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    logger.info('SQLite database closed and Discord client destroyed.');
    process.exit(0);
  } catch (err) {
    logger.error('Error during graceful shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

if (!config.discordToken) {
  logger.warn('⚠️ DISCORD_TOKEN is empty in .env. Bot will not connect to Discord until configured.');
} else {
  client.login(config.discordToken).catch(err => {
    logger.error('Failed to log in to Discord:', err);
  });
}

export default client;

