import {
  ChatInputCommandInteraction,
  REST,
  Routes,
  MessageFlags,
} from 'discord.js';
import { queueCommand } from '../commands/queue';
import { matchCommand } from '../commands/match';
import { statsCommand, leaderboardCommand, setMmrCommand, historyCommand } from '../commands/stats';
import { helpCommand } from '../commands/help';
import { banCommand } from '../commands/ban';
import { seasonCommand } from '../commands/season';
import { divisionCommand } from '../commands/division';
import { replayCommand } from '../commands/replay';
import { themeCommand } from '../commands/theme';
import { feedbackCommand } from '../commands/feedback';
import { setupCommand } from '../commands/setup';
import config from '../config';
import { logger } from '../utils/logger';

export const commands = [
  queueCommand,
  matchCommand,
  statsCommand,
  leaderboardCommand,
  setMmrCommand,
  historyCommand,
  helpCommand,
  banCommand,
  seasonCommand,
  divisionCommand,
  replayCommand,
  themeCommand,
  feedbackCommand,
  setupCommand,
];

/**
 * Executes a slash command when received.
 */
export async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const command = commands.find(c => c.data.name === interaction.commandName);
  if (!command) {
    await interaction.reply({ content: '❌ Unknown command!', flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    logger.error(`Error executing command ${interaction.commandName}:`, error);
    const content = '❌ An error occurred while executing this command.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content }).catch(() => null);
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  }
}

/**
 * Registers all slash commands with Discord API.
 */
/**
 * Register slash commands. With `guildIds`, registers to each of those guilds (instant;
 * used on boot with every guild the bot is in). Without, falls back to GUILD_ID from
 * .env, or global registration (up to an hour to propagate) if that is unset.
 */
export async function registerCommands(guildIds?: string[]): Promise<void> {
  if (!config.discordToken || !config.clientId) {
    logger.warn('DISCORD_TOKEN or CLIENT_ID missing in .env. Skipping command registration.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const body = commands.map(c => c.data.toJSON());

  try {
    if (guildIds) {
      for (const guildId of guildIds) {
        logger.info(`Registering ${body.length} commands to Guild ${guildId}...`);
        await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body });
      }
      logger.info(`Successfully registered slash commands in ${guildIds.length} guild(s)!`);
    } else if (config.guildId) {
      logger.info(`Registering ${body.length} commands to Guild ${config.guildId}...`);
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
        body,
      });
      logger.info('Successfully registered guild slash commands!');
    } else {
      logger.info(`Registering ${body.length} global slash commands...`);
      await rest.put(Routes.applicationCommands(config.clientId), {
        body,
      });
      logger.info('Successfully registered global slash commands!');
    }
  } catch (error) {
    logger.error('Failed to register slash commands:', error);
  }
}
