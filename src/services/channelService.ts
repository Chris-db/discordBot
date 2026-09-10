import {
  Client,
  Guild,
  ChannelType,
  CategoryChannel,
  TextChannel,
  VoiceChannel,
  PermissionFlagsBits,
  OverwriteType,
  AttachmentBuilder,
} from 'discord.js';
import { logger } from '../utils/logger';
import { getMatch, updateMatch, getPlayersByIds, getQueue } from '../database/queries';
import { tryMovePlayersToVoice } from './voiceService';
import { buildPublicFeedCardEmbed } from '../ui/embeds';
import { generateMatchResultImage } from './resultImage';
import { calculateMmrDelta } from './mmrService';

const CATEGORY_NAME = '🎮 ACTIVE 6MANS MATCHES';

/**
 * Finds or creates the Discord Category for active 6mans match channels.
 */
export async function getOrCreateMatchCategory(guild: Guild): Promise<CategoryChannel> {
  const existing = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === CATEGORY_NAME.toLowerCase()
  ) as CategoryChannel | undefined;

  if (existing) return existing;

  const created = await guild.channels.create({
    name: CATEGORY_NAME,
    type: ChannelType.GuildCategory,
  });
  return created;
}

/**
 * Validates that the bot has all required guild permissions for channel creation and permission overwrites.
 * Logs warnings/errors if required permissions are missing.
 */
export async function checkBotGuildPermissions(guild: Guild): Promise<void> {
  const botMember = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!botMember) {
    logger.warn(`Could not fetch Bot member in guild "${guild.name}" to verify permissions.`);
    return;
  }

  if (botMember.permissions.has(PermissionFlagsBits.Administrator)) {
    return; // Administrator has all permissions
  }

  const requiredPerms = [
    { bit: PermissionFlagsBits.ManageChannels, name: 'Manage Channels' },
    { bit: PermissionFlagsBits.ManageRoles, name: 'Manage Roles (Manage Permissions)' },
    { bit: PermissionFlagsBits.MoveMembers, name: 'Move Members' },
    { bit: PermissionFlagsBits.ManageMessages, name: 'Manage Messages' },
    { bit: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
    { bit: PermissionFlagsBits.SendMessages, name: 'Send Messages' },
    { bit: PermissionFlagsBits.Connect, name: 'Connect' },
    { bit: PermissionFlagsBits.Speak, name: 'Speak' },
  ];

  const missingPerms: string[] = [];
  for (const p of requiredPerms) {
    if (!botMember.permissions.has(p.bit)) {
      missingPerms.push(p.name);
    }
  }

  if (missingPerms.length > 0) {
    logger.error(
      `❌ [MISSING SERVER PERMISSIONS] In guild "${guild.name}", the bot role is missing: ${missingPerms.join(', ')}`
    );
    logger.error(
      `❌ Discord API v10 requires 'Manage Roles' (Manage Permissions) AND 'Manage Channels' to create private channels with custom permission overwrites.`
    );
    logger.error(
      `❌ Please grant 'Administrator' OR check '${missingPerms.join("', '")}' in your Discord Server Settings -> Roles for the bot.`
    );
  }
}

/**
 * Creates temporary private text channel (#match-ID) and public read-only voice channels
 * inside the queue channel's Category (e.g. Rank A / Rank B).
 */
export async function createMatchChannels(
  client: Client,
  guildId: string,
  matchId: number,
  playerIds: string[],
  parentChannelId?: string
): Promise<{ textChannelId: string; blueVoiceId?: string; orangeVoiceId?: string }> {
  const guild = await client.guilds.fetch(guildId);
  if (!guild) {
    throw new Error(`Guild ${guildId} not found`);
  }

  await checkBotGuildPermissions(guild);

  let categoryId: string;
  if (parentChannelId) {
    const parentChan = await guild.channels.fetch(parentChannelId).catch(() => null);
    if (!parentChan || !('parentId' in parentChan) || !parentChan.parentId) {
      throw new Error(
        `Queue channel (<#${parentChannelId}>) is not placed inside a Category! Please move your queue channel into a Discord Category (e.g. "Rank A", "Rank B") so match channels can be created there.`
      );
    }
    categoryId = parentChan.parentId;
  } else {
    const category = await getOrCreateMatchCategory(guild);
    categoryId = category.id;
  }

  // Build permission overrides for text channel (#match-101):
  // @everyone cannot view; only the lobby can view/send messages
  const textOverrides: any[] = [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      deny: [PermissionFlagsBits.ViewChannel],
    },
  ];

  if (client.user?.id) {
    textOverrides.push({
      id: client.user.id,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  for (const pid of playerIds) {
    // Check if playerId is a test bot
    if (pid.startsWith('test_bot_')) continue;
    textOverrides.push({
      id: pid,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  // Create temporary private text channel
  const textChan = await guild.channels.create({
    name: `match-${matchId}`,
    type: ChannelType.GuildText,
    parent: categoryId,
    permissionOverwrites: textOverrides,
    topic: `Rocket League 6mans | Match #${matchId} | Private Lobby`,
  });

  const voiceOverrides: any[] = [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [PermissionFlagsBits.Connect],
    },
  ];
  if (client.user?.id) {
    voiceOverrides.push({
      id: client.user.id,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.ManageChannels,
      ],
    });
  }

  // Persist channel ID in DB
  updateMatch(matchId, {
    text_channel_id: textChan.id,
  });

  logger.info(`Created match text channel for Match #${matchId} in category ${categoryId}: #${textChan.name}`);

  return {
    textChannelId: textChan.id,
    blueVoiceId: undefined,
    orangeVoiceId: undefined,
  };
}

/**
 * Creates Team Blue and Team Orange voice channels once Ready Check is completed and teams are chosen.
 */
export async function createTeamVoiceChannels(
  client: Client,
  guildId: string,
  matchId: number,
  blueTeamIds: string[],
  orangeTeamIds: string[],
  parentChannelId?: string
): Promise<{ blueVoiceId: string; orangeVoiceId: string }> {
  const guild = await client.guilds.fetch(guildId);
  if (!guild) {
    throw new Error(`Guild ${guildId} not found`);
  }

  await checkBotGuildPermissions(guild);

  let categoryId: string;
  if (parentChannelId) {
    const parentChan = await guild.channels.fetch(parentChannelId).catch(() => null);
    if (parentChan && 'parentId' in parentChan && parentChan.parentId) {
      categoryId = parentChan.parentId;
    } else {
      const category = await getOrCreateMatchCategory(guild);
      categoryId = category.id;
    }
  } else {
    const category = await getOrCreateMatchCategory(guild);
    categoryId = category.id;
  }

  const voiceOverrides: any[] = [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [PermissionFlagsBits.Connect],
    },
  ];
  if (client.user?.id) {
    voiceOverrides.push({
      id: client.user.id,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.ManageChannels,
      ],
    });
  }

  for (const pid of [...blueTeamIds, ...orangeTeamIds]) {
    if (pid.startsWith('test_bot_')) continue;
    voiceOverrides.push({
      id: pid,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    });
  }

  const blueVoice = await guild.channels.create({
    name: `🔵 Team Blue [Match #${matchId}]`,
    type: ChannelType.GuildVoice,
    parent: categoryId,
    userLimit: 3,
    permissionOverwrites: voiceOverrides,
  });

  const orangeVoice = await guild.channels.create({
    name: `🟠 Team Orange [Match #${matchId}]`,
    type: ChannelType.GuildVoice,
    parent: categoryId,
    userLimit: 3,
    permissionOverwrites: voiceOverrides,
  });

  updateMatch(matchId, {
    blue_voice_id: blueVoice.id,
    orange_voice_id: orangeVoice.id,
  });

  logger.info(`Created Team Blue & Orange VCs for Match #${matchId} in category ${categoryId}`);

  await tryMovePlayersToVoice(guild, blueTeamIds, orangeTeamIds, blueVoice.id, orangeVoice.id);

  return {
    blueVoiceId: blueVoice.id,
    orangeVoiceId: orangeVoice.id,
  };
}

/**
 * Grants Connect permissions to Team Blue and Team Orange players for their respective voice channels,
 * and automatically moves them if they are connected to server voice.
 */
export async function grantTeamVoiceAccessAndMove(
  client: Client,
  guildId: string,
  matchId: number,
  blueTeamIds: string[],
  orangeTeamIds: string[]
): Promise<{ blueVoiceId?: string; orangeVoiceId?: string }> {
  const match = getMatch(matchId);
  if (!match) return {};

  try {
    const guild = await client.guilds.fetch(guildId);
    if (!guild) return {};

    if (!match.blue_voice_id || !match.orange_voice_id) {
      const vcs = await createTeamVoiceChannels(
        client,
        guildId,
        matchId,
        blueTeamIds,
        orangeTeamIds,
        match.text_channel_id || match.channel_id
      );
      return vcs;
    }

    const blueVoice = (await guild.channels.fetch(match.blue_voice_id).catch(() => null)) as VoiceChannel;
    const orangeVoice = (await guild.channels.fetch(match.orange_voice_id).catch(() => null)) as VoiceChannel;

    if (blueVoice) {
      for (const id of blueTeamIds) {
        if (id.startsWith('test_bot_')) continue;
        await blueVoice.permissionOverwrites.edit(id, {
          ViewChannel: true,
          Connect: true,
          Speak: true,
        }).catch(() => null);
      }
    }

    if (orangeVoice) {
      for (const id of orangeTeamIds) {
        if (id.startsWith('test_bot_')) continue;
        await orangeVoice.permissionOverwrites.edit(id, {
          ViewChannel: true,
          Connect: true,
          Speak: true,
        }).catch(() => null);
      }
    }

    // Move connected players into their team voice channel
    await tryMovePlayersToVoice(guild, blueTeamIds, orangeTeamIds, match.blue_voice_id, match.orange_voice_id);
    return { blueVoiceId: match.blue_voice_id, orangeVoiceId: match.orange_voice_id };
  } catch (err) {
    logger.warn(`Could not update team voice permissions for Match #${matchId}:`, err);
    return {};
  }
}

/**
 * Deletes temporary text and voice channels for a match.
 */
export async function deleteMatchChannels(client: Client, matchId: number): Promise<void> {
  const match = getMatch(matchId);
  if (!match) return;

  try {
    const guild = await client.guilds.fetch(match.guild_id);
    if (!guild) return;

    // Prefer the id stored on the match — the queue row it used to live on may already
    // have been deleted by whatever cancelled the match.
    const queueData = match.text_channel_id ? getQueue(match.text_channel_id) : getQueue(match.channel_id);
    const readyCheckVcId = match.ready_check_vc_id || queueData?.ready_check_vc_id;

    const channelIds = [match.text_channel_id, match.blue_voice_id, match.orange_voice_id, readyCheckVcId];
    for (const cid of channelIds) {
      if (!cid) continue;
      const chan = await guild.channels.fetch(cid).catch(() => null);
      if (chan) {
        await chan.delete().catch(() => null);
      }
    }
    logger.info(`Deleted temporary channels for Match #${matchId}.`);
  } catch (error) {
    logger.warn(`Error deleting channels for Match #${matchId}:`, error);
  }
}

/**
 * Schedules automatic deletion of match text & voice channels after a 30-second delay
 * so players can read final scores and say GG.
 */
/**
 * Pending teardowns, keyed by match id.
 *
 * The timer used to be a bare setTimeout with no handle, so nothing could stop a teardown
 * once it was scheduled -- which makes a rematch impossible, since the channels the
 * rematch runs in are the ones being deleted.
 */
const pendingChannelDeletions = new Map<number, NodeJS.Timeout>();

export function scheduleMatchChannelDeletion(client: Client, matchId: number, delayMs = 30000): void {
  cancelMatchChannelDeletion(matchId);
  const timer = setTimeout(() => {
    pendingChannelDeletions.delete(matchId);
    deleteMatchChannels(client, matchId);
  }, delayMs);
  pendingChannelDeletions.set(matchId, timer);
}

/** Stops a scheduled teardown. Returns true if one was actually pending. */
export function cancelMatchChannelDeletion(matchId: number): boolean {
  const timer = pendingChannelDeletions.get(matchId);
  if (!timer) return false;
  clearTimeout(timer);
  pendingChannelDeletions.delete(matchId);
  return true;
}

/** Whether a teardown is scheduled for this match. Exists so tests can see the timer. */
export function hasPendingChannelDeletion(matchId: number): boolean {
  return pendingChannelDeletions.has(matchId);
}

/**
 * Finds the public #active-matches feed channel in the guild.
 */
export async function findFeedChannel(guild: Guild): Promise<TextChannel | null> {
  const possibleNames = ['active-matches', 'match-feed', '6mans-feed', 'current-matches', 'matches'];
  const found = guild.channels.cache.find(
    c => c.type === ChannelType.GuildText && possibleNames.includes(c.name.toLowerCase())
  ) as TextChannel | undefined;
  return found || null;
}

/**
 * Broadcasts an active match to the public feed channel.
 */
export async function broadcastMatchToFeed(client: Client, matchId: number): Promise<void> {
  const match = getMatch(matchId);
  if (!match) return;

  try {
    const guild = await client.guilds.fetch(match.guild_id);
    if (!guild) return;

    const feedChan = await findFeedChannel(guild);
    if (!feedChan) return;

    const bluePlayers = getPlayersByIds(match.guild_id, match.team_size, match.blue_team);
    const orangePlayers = getPlayersByIds(match.guild_id, match.team_size, match.orange_team);

    const embed = buildPublicFeedCardEmbed(
      matchId,
      match.state as any,
      bluePlayers,
      orangePlayers,
      match.winner as any
    );
    const msg = await feedChan.send({ embeds: [embed] });

    updateMatch(matchId, {
      feed_channel_id: feedChan.id,
      feed_message_id: msg.id,
    });
  } catch (error) {
    logger.warn(`Could not broadcast Match #${matchId} to feed channel:`, error);
  }
}

/**
 * Updates the public feed card when a match completes or is cancelled.
 */
export async function updateMatchFeedCard(client: Client, matchId: number): Promise<void> {
  const match = getMatch(matchId);
  if (!match || !match.feed_channel_id || !match.feed_message_id) return;

  try {
    const guild = await client.guilds.fetch(match.guild_id);
    if (!guild) return;

    const feedChan = (await guild.channels.fetch(match.feed_channel_id).catch(() => null)) as TextChannel;
    if (!feedChan) return;

    const msg = await feedChan.messages.fetch(match.feed_message_id).catch(() => null);
    if (!msg) return;

    const bluePlayers = getPlayersByIds(match.guild_id, match.team_size, match.blue_team);
    const orangePlayers = getPlayersByIds(match.guild_id, match.team_size, match.orange_team);

    const embed = buildPublicFeedCardEmbed(
      matchId,
      match.state as any,
      bluePlayers,
      orangePlayers,
      match.winner as any
    );

    if (match.state === 'COMPLETED' && (match.winner === 'BLUE' || match.winner === 'ORANGE')) {
      // Use the deltas that were actually applied, recorded by completeMatch. Recomputing
      // here would run the Elo expectation against the already-updated ratings and show
      // players a number that doesn't match what they gained.
      const stored = match.gamble_status;
      const recomputed =
        stored?.blueDelta === undefined || stored?.orangeDelta === undefined
          ? calculateMmrDelta(bluePlayers, orangePlayers, match.winner)
          : undefined;
      const blueDelta = stored?.blueDelta ?? recomputed!.blueDelta;
      const orangeDelta = stored?.orangeDelta ?? recomputed!.orangeDelta;

      const blueResults = bluePlayers.map(p => ({ player: p, delta: blueDelta, newMmr: p.mmr }));
      const orangeResults = orangePlayers.map(p => ({ player: p, delta: orangeDelta, newMmr: p.mmr }));

      const imageBuffer = await generateMatchResultImage(client, matchId, match.winner, blueResults, orangeResults);
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'match_result.png' });

      // The result image already names the match, the winner and every delta, so the
      // roster embed is dropped rather than stacked on top of it.
      await msg.edit({ embeds: [], files: [attachment], attachments: [] });
    } else {
      await msg.edit({ embeds: [embed] });
    }
  } catch (error) {
    logger.warn(`Could not update feed card for Match #${matchId}:`, error);
  }
}
