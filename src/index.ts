import {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
} from 'discord.js';
import config, { validateConfig } from './config';
import { initializeDatabase } from './database/schema';
import { handleCommand, registerCommands } from './handlers/commandHandler';
import { handleInteraction } from './handlers/interactionHandler';
import {
  handleChannelMessage,
  checkQueueTimeouts,
  sweepStaleMatches,
  recoverStuckQueues,
} from './services/queueService';
import { sweepOrphanedMatchChannels, sweepStrayQueuePanels } from './services/queueTimeout';
import { startBackupSchedule } from './services/backupService';
import { startHeartbeat } from './services/heartbeat';
import { withGuildTheme } from './services/themeService';
import { ensureGuildDefaults } from './services/guildSetup';
// Registers the bundled fonts before anything can draw a card. The image modules import
// this too, so it is belt and braces -- but it means a missing font file is reported at
// boot rather than the first time someone completes a match.
import { registerFonts } from './utils/fonts';
import { logger } from './utils/logger';
import db from './database/db';

// Refuse to start on a broken .env. Under systemd a process that idles with a warning
// looks identical to one that is working; a clear exit shows up in `systemctl status`.
const configProblems = validateConfig();
if (configProblems.length > 0) {
  for (const problem of configProblems) logger.error(`Config: ${problem}`);
  logger.error('Fix .env and restart.');
  process.exit(1);
}

registerFonts();

// Initialize SQLite database schema
initializeDatabase();

// No MessageContent intent: the only message listener re-pins the queue panel, and it
// needs `author.bot` and `channelId`, both of which arrive without the privileged intent.
// Asking for it would mean every server that installs the bot has to grant a permission
// the bot never uses.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// Invited to a new server while running: give it its divisions and register commands
// there, so it works at once.
client.on(Events.GuildCreate, guild => {
  ensureGuildDefaults(guild.id);
  registerCommands([guild.id]).catch(err => {
    logger.error(`Error registering commands in new guild ${guild.id}:`, err);
  });
});

client.once(Events.ClientReady, async readyClient => {
  logger.info(`🚀 Logged in as ${readyClient.user.tag}! Rocket League 6mans bot is online.`);

  readyClient.user.setActivity('Rocket League 6mans (/queue panel)', {
    type: ActivityType.Playing,
  });

  // Register to every guild the bot is in: per-guild registration is instant, whereas
  // global registration can take up to an hour to show up.
  for (const guildId of readyClient.guilds.cache.keys()) ensureGuildDefaults(guildId);
  if (config.discordToken && config.clientId) {
    await registerCommands([...readyClient.guilds.cache.keys()]);
  }

  // Recover any queues left in temporary states from before a crash/restart, then remove
  // the channels of matches that finished but whose teardown timer died with the old
  // process. In that order: the recovery cancels matches and schedules their teardown,
  // which the sweep then knows to leave alone.
  recoverStuckQueues(readyClient)
    .catch(err => {
      logger.error('Error recovering stuck queues:', err);
    })
    .then(() => sweepOrphanedMatchChannels(readyClient))
    .then(() => sweepStrayQueuePanels(readyClient))
    .catch(err => {
      logger.error('Error sweeping orphaned channels:', err);
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

  // Tell the uptime monitor we are here, and keep telling it while the gateway is up.
  startHeartbeat(readyClient);

  // Checkpoint SQLite WAL every 30 minutes to maintain small WAL file sizes
  setInterval(() => {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      logger.error('Error checkpointing SQLite WAL:', err);
    }
  }, 30 * 60_000);
});

// Every handler runs inside its guild's colour theme, so any card it draws -- now or on a
// timer it schedules -- comes out in that server's palette.
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      await withGuildTheme(interaction.guildId, () => handleCommand(interaction));
    } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
      await withGuildTheme(interaction.guildId, () => handleInteraction(interaction));
    }
  } catch (error) {
    logger.error('Unhandled interaction error:', error);
  }
});

client.on(Events.MessageCreate, message => {
  try {
    withGuildTheme(message.guildId, () => handleChannelMessage(client, message));
  } catch (error) {
    logger.error('Error handling channel message:', error);
  }
});

// A rejected promise nobody awaited is almost always a Discord call that failed after the
// interaction had already been answered. Log it and carry on.
process.on('unhandledRejection', error => {
  logger.error('Unhandled Rejection:', error);
});

// An uncaught exception is different: whatever threw was mid-way through something, and
// its timers, locks and half-written state are still in memory. Carrying on from here
// used to be the policy, which meant one bad throw could leave a lobby that would never
// advance and never be recovered. Exit instead -- systemd restarts the process in about
// a second, and recoverStuckQueues does the honest cleanup on boot.
process.on('uncaughtException', error => {
  logger.error('Uncaught Exception -- exiting so the supervisor restarts a clean process:', error);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    // The database may be what threw; nothing more to do for it.
  }
  process.exit(1);
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

client.login(config.discordToken).catch(err => {
  logger.error('Failed to log in to Discord:', err);
  process.exit(1);
});

export default client;

