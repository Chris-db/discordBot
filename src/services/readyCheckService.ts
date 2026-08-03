import {
  Client,
  TextChannel,
  Message,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  AttachmentBuilder,
} from 'discord.js';
import {
  getQueue,
  saveQueue,
  deleteQueue,
  getPlayersByIds,
  createMatch,
  updateMatch,
  ActiveQueue,
} from '../database/queries';
import { createMatchChannels, deleteMatchChannels } from './channelService';
import { generateReadyCheckImage } from './readyCheckImage';
import { logger } from '../utils/logger';
import { getOrInitQueue, refreshQueuePanel } from './queuePanel';
import { startVotingPhase } from './votingService';

/**
 * Starts the 60-second AFK Voice Ready Check when 6 players are reached.
 */
export async function startReadyCheckPhase(
  client: Client,
  channelId: string,
  guildId: string,
  queue: ActiveQueue
): Promise<void> {
  // If all players are bots, skip ready check and jump directly to voting
  const allBots = queue.player_ids.every(id => id.startsWith('test_bot_'));
  if (allBots) {
    queue.state = 'VOTING';
    queue.vote_counts = { captains: [], balanced: [], random: [] };
    saveQueue(queue);
    await startVotingPhase(client, channelId, guildId, queue);
    return;
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    queue.state = 'VOTING';
    queue.vote_counts = { captains: [], balanced: [], random: [] };
    saveQueue(queue);
    await startVotingPhase(client, channelId, guildId, queue);
    return;
  }

  const queueChannel = (await guild.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
  if (!queueChannel) {
    queue.state = 'VOTING';
    queue.vote_counts = { captains: [], balanced: [], random: [] };
    saveQueue(queue);
    await startVotingPhase(client, channelId, guildId, queue);
    return;
  }

  const categoryId = queueChannel.parentId;
  if (!categoryId) {
    await queueChannel.send({
      content: `❌ **Error:** Queue channel (<#${queueChannel.id}>) is not inside a Discord Category! Skipping ready check...`,
    });
    queue.state = 'VOTING';
    queue.vote_counts = { captains: [], balanced: [], random: [] };
    saveQueue(queue);
    await startVotingPhase(client, channelId, guildId, queue);
    return;
  }

  // Build permission overrides: only the 6 players, Admins/Mods, and bot can view/connect
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

  for (const discordId of queue.player_ids) {
    if (discordId.startsWith('test_bot_')) continue;
    voiceOverrides.push({
      id: discordId,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    });
  }

  // Create SQLite match record in READY_CHECK state
  const match = createMatch({
    guild_id: guildId,
    channel_id: channelId,
    state: 'READY_CHECK',
    blue_team: [...queue.player_ids],
    orange_team: [],
    rl_name: '',
    rl_pass: '',
  });

  // Create private match text channel and team VCs early so players can see ready check inside #match-ID
  const { textChannelId } = await createMatchChannels(
    client,
    guildId,
    match.match_id,
    queue.player_ids,
    channelId
  );

  let readyCheckVc;
  try {
    readyCheckVc = await guild.channels.create({
      name: `🔊 Ready Check #${match.match_id}`,
      type: ChannelType.GuildVoice,
      parent: categoryId,
      userLimit: 6,
      permissionOverwrites: voiceOverrides,
    });
  } catch (err) {
    logger.error('Failed to create Ready Check VC:', err);
    updateMatch(match.match_id, { state: 'VOTING' });
    queue.state = 'VOTING';
    queue.vote_counts = { captains: [], balanced: [], random: [] };
    saveQueue(queue);
    await startVotingPhase(client, channelId, guildId, queue, undefined, match, textChannelId);
    return;
  }

  // 1. Save matchQueue for textChannelId (#match-123) in READY_CHECK state so timer and voting can run against it
  const matchQueue: ActiveQueue = {
    channel_id: textChannelId,
    guild_id: guildId,
    player_ids: [...queue.player_ids],
    player_join_times: queue.player_join_times ? { ...queue.player_join_times } : undefined,
    state: 'READY_CHECK',
    ready_check_vc_id: readyCheckVc.id,
    vote_counts: { captains: [], balanced: [], random: [] },
  };
  saveQueue(matchQueue);

  // 2. Immediately reset the original rank queue channel so new players can join concurrently during Ready Check!
  queue.player_ids = [];
  queue.player_join_times = {};
  queue.state = 'WAITING';
  queue.vote_counts = {};
  queue.draft_state = undefined;
  queue.ready_check_vc_id = undefined;
  saveQueue(queue);
  await refreshQueuePanel(client, channelId);

  const mentions = matchQueue.player_ids
    .filter(id => !id.startsWith('test_bot_'))
    .map(id => `<@${id}>`)
    .join(' ');

  const matchTextChannel = (await guild.channels.fetch(textChannelId).catch(() => null)) as TextChannel;
  let readyMsg: Message | undefined;
  if (matchTextChannel) {
    const players = getPlayersByIds(matchQueue.player_ids);
    const readyImg = await generateReadyCheckImage(client, players, [], 60);
    const attachment = new AttachmentBuilder(readyImg, { name: 'ready_check.png' });

    readyMsg = await matchTextChannel.send({
      content:
        `🚨 **QUEUE FULL (6/6)! AFK VOICE READY CHECK!**\n` +
        `${mentions}\n\n` +
        `⏳ **You have 60 seconds to connect to <#${readyCheckVc.id}>!**\n` +
        `*All 6 players must join the voice channel to confirm they are ready. Anyone who fails to join within 60s will be removed from the queue.*`,
      files: [attachment],
    }).catch(() => undefined);
  }

  const popNotice = await queueChannel.send({
    content: `🔔 **Queue Full (6/6)!** Match **#${match.match_id}** lobby created in <#${textChannelId}>. Please connect to **🔊 Ready Check #${match.match_id}** (<#${readyCheckVc.id}>) within 60 seconds!`,
  }).catch(() => null);
  setTimeout(() => popNotice?.delete().catch(() => null), 15_000);

  const readyCheckStartedAt = Date.now();
  const timer = setInterval(async () => {
    const elapsed = Math.floor((Date.now() - readyCheckStartedAt) / 1000);
    const currentQueue = getQueue(textChannelId);
    if (!currentQueue || currentQueue.state !== 'READY_CHECK') {
      clearInterval(timer);
      return;
    }

    const vc = await guild.channels.fetch(readyCheckVc.id).catch(() => null);
    if (!vc || vc.type !== ChannelType.GuildVoice) {
      clearInterval(timer);
      return;
    }

    const allReady = currentQueue.player_ids.every(id => {
      if (id.startsWith('test_bot_')) return true;
      return vc.members.has(id);
    });

    if (allReady) {
      clearInterval(timer);
      if (readyMsg) {
        await readyMsg.edit({
          content: `✅ **ALL PLAYERS READY!** Starting mode voting...`,
        }).catch(() => null);
      }

      currentQueue.state = 'VOTING';
      currentQueue.vote_counts = { captains: [], balanced: [], random: [] };
      saveQueue(currentQueue);

      await startVotingPhase(client, channelId, guildId, currentQueue, readyCheckVc.id, match, textChannelId);
      return;
    }

    if (elapsed % 6 === 0 && readyMsg) {
      const players = getPlayersByIds(currentQueue.player_ids);
      const readyIds = Array.from(vc.members.keys());
      const readyImg = await generateReadyCheckImage(client, players, readyIds, Math.max(0, 60 - elapsed));
      const attachment = new AttachmentBuilder(readyImg, { name: 'ready_check.png' });
      await readyMsg.edit({
        files: [attachment],
      }).catch(() => null);
    }

    if (elapsed >= 60) {
      clearInterval(timer);

      const afkPlayerIds = currentQueue.player_ids.filter(id => {
        if (id.startsWith('test_bot_')) return false;
        return !vc.members.has(id);
      });
      const readyPlayerIds = currentQueue.player_ids.filter(id => !afkPlayerIds.includes(id));

      updateMatch(match.match_id, {
        state: 'CANCELLED',
        winner: 'NONE',
        completed_at: new Date().toISOString(),
      });

      const afkMentions = afkPlayerIds.map(id => `<@${id}>`).join(', ');
      if (matchTextChannel) {
        await matchTextChannel.send({
          content:
            `❌ **READY CHECK FAILED!**\n` +
            `The following player(s) failed to join voice within 60s: ${afkMentions || 'Unknown'}\n` +
            `Closing match lobby in 5 seconds...`,
        }).catch(() => null);
      }

      // Return non-AFK players to the front of the rank queue
      const rankQueue = getOrInitQueue(channelId, guildId);
      const combinedIds: string[] = [];
      const combinedJoinTimes: Record<string, number> = {};

      for (const id of readyPlayerIds) {
        if (!combinedIds.includes(id)) {
          combinedIds.push(id);
          combinedJoinTimes[id] = currentQueue.player_join_times?.[id] || Date.now();
        }
      }
      for (const id of rankQueue.player_ids) {
        if (!combinedIds.includes(id)) {
          combinedIds.push(id);
          combinedJoinTimes[id] = rankQueue.player_join_times?.[id] || Date.now();
        }
      }

      if (combinedIds.length >= 6) {
        const nextMatchIds = combinedIds.slice(0, 6);
        const remainingIds = combinedIds.slice(6);

        rankQueue.player_ids = remainingIds;
        rankQueue.player_join_times = {};
        for (const id of remainingIds) {
          rankQueue.player_join_times[id] = combinedJoinTimes[id];
        }
        saveQueue(rankQueue);
        await refreshQueuePanel(client, channelId);

        const afkNotice = await queueChannel.send({
          content:
            `❌ **Ready Check Failed in Match #${match.match_id}.**\n` +
            `Removed AFK player(s): ${afkMentions || 'Unknown'}. Queue popped again (**6/6**)!`,
        }).catch(() => null);
        setTimeout(() => afkNotice?.delete().catch(() => null), 15_000);

        const popQueue: ActiveQueue = {
          channel_id: channelId,
          guild_id: guildId,
          player_ids: nextMatchIds,
          player_join_times: {},
          state: 'WAITING',
          vote_counts: {},
        };
        for (const id of nextMatchIds) {
          popQueue.player_join_times![id] = combinedJoinTimes[id];
        }
        await startReadyCheckPhase(client, channelId, guildId, popQueue);
      } else {
        rankQueue.player_ids = combinedIds;
        rankQueue.player_join_times = combinedJoinTimes;
        saveQueue(rankQueue);
        await refreshQueuePanel(client, channelId);

        const afkNotice = await queueChannel.send({
          content:
            `❌ **Ready Check Failed in Match #${match.match_id}.**\n` +
            `Removed AFK player(s): ${afkMentions || 'Unknown'}. Queue is now **${rankQueue.player_ids.length}/6**.`,
        }).catch(() => null);
        setTimeout(() => afkNotice?.delete().catch(() => null), 15_000);
      }

      setTimeout(() => {
        vc.delete('AFK Ready check failed').catch(() => null);
        deleteMatchChannels(client, match.match_id);
        deleteQueue(textChannelId);
      }, 5000);
    }
  }, 3000);
}
