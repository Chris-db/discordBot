import { Guild, ChannelType } from 'discord.js';
import { logger } from '../utils/logger';

export interface VoiceChannelPair {
  blueVoiceId?: string;
  orangeVoiceId?: string;
}

/**
 * Creates temporary Team Blue and Team Orange voice channels for a match.
 */
export async function createMatchVoiceChannels(
  guild: Guild,
  matchId: number,
  parentCategoryId?: string
): Promise<VoiceChannelPair> {
  try {
    const blueChannel = await guild.channels.create({
      name: `🔵 Team Blue [Match #${matchId}]`,
      type: ChannelType.GuildVoice,
      parent: parentCategoryId || undefined,
      reason: `6mans match #${matchId} voice channel for Team Blue`,
    });

    const orangeChannel = await guild.channels.create({
      name: `🟠 Team Orange [Match #${matchId}]`,
      type: ChannelType.GuildVoice,
      parent: parentCategoryId || undefined,
      reason: `6mans match #${matchId} voice channel for Team Orange`,
    });

    logger.info(
      `Created temporary voice channels for Match #${matchId}: Blue (${blueChannel.id}), Orange (${orangeChannel.id})`
    );

    return {
      blueVoiceId: blueChannel.id,
      orangeVoiceId: orangeChannel.id,
    };
  } catch (error) {
    logger.error(`Failed to create voice channels for match id ${matchId}:`, error);
    return {};
  }
}

/**
 * Attempts to move players into their assigned team voice channels if they are already connected to voice in the server.
 */
export async function tryMovePlayersToVoice(
  guild: Guild,
  blueTeamIds: string[],
  orangeTeamIds: string[],
  blueVoiceId?: string,
  orangeVoiceId?: string
): Promise<void> {
  if (!blueVoiceId && !orangeVoiceId) return;

  const allIds = [...blueTeamIds, ...orangeTeamIds];
  for (const discordId of allIds) {
    try {
      const member = await guild.members.fetch(discordId).catch(() => null);
      if (member && member.voice && member.voice.channelId) {
        const targetVoiceId = blueTeamIds.includes(discordId) ? blueVoiceId : orangeVoiceId;
        if (targetVoiceId && member.voice.channelId !== targetVoiceId) {
          await member.voice.setChannel(targetVoiceId, '6mans auto-move to team channel');
          logger.info(`Moved user ${member.user.tag} to voice channel ${targetVoiceId}`);
        }
      }
    } catch (error) {
      logger.warn(`Could not move user ${discordId} to team voice channel:`, error);
    }
  }
}

/**
 * Deletes the temporary voice channels when a match ends or is cancelled.
 */
export async function deleteMatchVoiceChannels(
  guild: Guild,
  blueVoiceId?: string,
  orangeVoiceId?: string
): Promise<void> {
  const channelIds = [blueVoiceId, orangeVoiceId].filter(Boolean) as string[];
  for (const channelId of channelIds) {
    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel) {
        await channel.delete('6mans match completed or cancelled');
        logger.info(`Deleted temporary voice channel ${channelId}`);
      }
    } catch (error) {
      logger.error(`Failed to delete temporary voice channel ${channelId}:`, error);
    }
  }
}
