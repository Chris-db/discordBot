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
  mutateQueue,
  getPlayersByIds,
  getActiveMatchForPlayer,
  createMatch,
  updateMatch,
  ActiveQueue,
} from '../database/queries';
import { createMatchChannels, deleteMatchChannels } from './channelService';
import { generateReadyCheckImage } from './readyCheckImage';
import { logger } from '../utils/logger';
import config from '../config';
import { getOrInitQueue, refreshQueuePanel, removePlayersFromWaitingQueues } from './queuePanel';
import { startVotingPhase } from './votingService';

/**
 * Drops anyone who already has a live match from a lobby that is about to pop, and says
 * whether it is still full.
 *
 * Join Queue refuses a player who is mid-match, but only at join time. The pop path now
 * takes a popped roster out of every other waiting queue, and this is the backstop for
 * whatever gets past that -- /queue add, a requeue racing a pop -- because a queue must
 * never pop with a player who is already in a match. Test bots are exempt: they are
 * shared fixtures, and a bot lobby running in one channel would otherwise make /queue
 * fill in a second channel silently refuse to pop.
 *
 * The lobby and the queue row are not always the same list. On an ordinary pop they are;
 * on a re-pop after a failed ready check the caller has already sliced the lobby off the
 * front of the row, and the row holds whoever is waiting behind. So the gap a dropped
 * player leaves is filled from the waiting list, and whoever cannot pop goes back into
 * the row -- lobby first, since they were ahead -- rather than being lost.
 *
 * Mutates `queue` to the roster that should pop. Only writes the row when something was
 * actually dropped.
 */
function dropBusyPlayers(channelId: string, guildId: string, queue: ActiveQueue): boolean {
  const rosterSize = queue.team_size * 2;
  const isBusy = (id: string) =>
    !id.startsWith('test_bot_') && getActiveMatchForPlayer(guildId, id) !== undefined;

  const busyIds = queue.player_ids.filter(isBusy);
  if (busyIds.length === 0) return queue.player_ids.length >= rosterSize;

  logger.warn(
    `Dropping ${busyIds.join(', ')} from the pop in ${channelId}: already in a live match.`
  );

  const lobby = new Set(queue.player_ids);
  const joinTimes: Record<string, number> = { ...(queue.player_join_times ?? {}) };
  let pool: string[] = [];

  const saved = mutateQueue(channelId, row => {
    for (const [id, t] of Object.entries(row.player_join_times ?? {})) {
      if (!(id in joinTimes)) joinTimes[id] = t;
    }
    pool = [...queue.player_ids, ...row.player_ids.filter(id => !lobby.has(id))].filter(
      id => !isBusy(id)
    );
    const keep = pool.length >= rosterSize ? pool.slice(rosterSize) : pool;
    row.player_ids = keep;
    row.player_join_times = Object.fromEntries(keep.map(id => [id, joinTimes[id] ?? Date.now()]));
  });
  if (!saved) {
    pool = queue.player_ids.filter(id => !isBusy(id));
  }

  queue.player_ids = pool.slice(0, rosterSize);
  queue.player_join_times = Object.fromEntries(
    queue.player_ids.map(id => [id, joinTimes[id] ?? Date.now()])
  );
  return queue.player_ids.length >= rosterSize;
}

/**
 * Starts the AFK Voice Ready Check once the queue is full. Its length is
 * `config.readyCheckTimeoutSeconds` (READY_CHECK_TIMEOUT_SECONDS, five minutes by default).
 */
export async function startReadyCheckPhase(
  client: Client,
  channelId: string,
  guildId: string,
  queue: ActiveQueue
): Promise<void> {
  const teamSize = queue.team_size;
  const rosterSize = teamSize * 2;

  // Both of these run before the branches below fork, because the all-bots path and the
  // no-guild / no-category fallbacks skip straight to voting and need the same treatment.
  if (!dropBusyPlayers(channelId, guildId, queue)) {
    await refreshQueuePanel(client, channelId);
    return;
  }
  await removePlayersFromWaitingQueues(client, guildId, queue.player_ids, channelId);

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
      content: `❌ <#${queueChannel.id}> is not inside a category — skipping the ready check.`,
    });
    queue.state = 'VOTING';
    queue.vote_counts = { captains: [], balanced: [], random: [] };
    saveQueue(queue);
    await startVotingPhase(client, channelId, guildId, queue);
    return;
  }

  // Build permission overrides: only the queued players, Admins/Mods, and bot can view/connect
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

  // Create SQLite match record in READY_CHECK state.
  // queue_channel_id is set here (not only later in startVotingPhase) so cancel/cleanup
  // paths can always tell the persistent rank queue apart from the temporary match queue.
  const match = createMatch({
    guild_id: guildId,
    channel_id: channelId,
    team_size: queue.team_size,
    queue_channel_id: channelId,
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
      userLimit: rosterSize,
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

  // Record the VC against the match, not just the queue row. cancelMatch deletes the queue
  // row before channel cleanup runs, which used to leave this VC orphaned in the server.
  updateMatch(match.match_id, { ready_check_vc_id: readyCheckVc.id });

  // 1. Save matchQueue for textChannelId (#match-123) in READY_CHECK state so timer and voting can run against it
  const matchQueue: ActiveQueue = {
    channel_id: textChannelId,
    guild_id: guildId,
    team_size: teamSize,
    player_ids: [...queue.player_ids],
    player_join_times: queue.player_join_times ? { ...queue.player_join_times } : undefined,
    state: 'READY_CHECK',
    ready_check_vc_id: readyCheckVc.id,
    vote_counts: { captains: [], balanced: [], random: [] },
  };
  saveQueue(matchQueue);

  // 2. Immediately free up the original rank queue channel so new players can join
  //    concurrently during Ready Check.
  //
  //    Remove only the players who popped, rather than clearing the row. Clearing it
  //    threw away anyone waiting behind them — which happened on every ready-check re-pop
  //    (the caller saves the overflow players, then this ran and wiped them) and any time
  //    a 7th player joined while the ready check was being set up.
  const poppedIds = new Set(matchQueue.player_ids);
  const sourceQueue = getQueue(channelId);
  if (sourceQueue) {
    sourceQueue.player_ids = sourceQueue.player_ids.filter(id => !poppedIds.has(id));
    const survivingJoinTimes: Record<string, number> = {};
    for (const id of sourceQueue.player_ids) {
      survivingJoinTimes[id] = sourceQueue.player_join_times?.[id] ?? Date.now();
    }
    sourceQueue.player_join_times = survivingJoinTimes;
    sourceQueue.state = 'WAITING';
    sourceQueue.vote_counts = {};
    sourceQueue.draft_state = undefined;
    sourceQueue.captain_vote_state = undefined;
    sourceQueue.team_vote_state = undefined;
    sourceQueue.ready_check_vc_id = undefined;
    saveQueue(sourceQueue);
  }
  await refreshQueuePanel(client, channelId);

  const mentions = matchQueue.player_ids
    .filter(id => !id.startsWith('test_bot_'))
    .map(id => `<@${id}>`)
    .join(' ');

  // Read once so the whole check runs on one number, even if config were reloaded.
  const timeoutSeconds = config.readyCheckTimeoutSeconds;
  const readyCheckStartedAt = Date.now();
  // Discord renders `<t:…:R>` as a live "in 4 minutes" / "in 30 seconds" on every
  // viewer's screen, ticking by itself. The image used to carry the countdown, but it
  // could only move as often as it was re-rendered and re-uploaded (every 6s), which read
  // as a stuck clock. The text is the countdown now; the image is who is in voice.
  const closesAt = `<t:${Math.floor((readyCheckStartedAt + timeoutSeconds * 1000) / 1000)}:R>`;

  const matchTextChannel = (await guild.channels.fetch(textChannelId).catch(() => null)) as TextChannel;
  let readyMsg: Message | undefined;
  if (matchTextChannel) {
    const players = getPlayersByIds(matchQueue.guild_id, matchQueue.team_size, matchQueue.player_ids);
    const readyImg = await generateReadyCheckImage(client, players, [], teamSize);
    const attachment = new AttachmentBuilder(readyImg, { name: 'ready_check.png' });

    // This is the single ping for the whole match. The card below it already states the
    // capacity and who is still missing, so the line only has to say who is being
    // summoned, where to, and by when.
    readyMsg = await matchTextChannel.send({
      content: `${mentions} → <#${readyCheckVc.id}> · closes ${closesAt}`,
      files: [attachment],
    }).catch(() => undefined);
  }

  // Pingless: everyone in this match was just mentioned in the match channel, and this
  // notice is only here so the queue channel says where the lobby went.
  //
  // It is kept for the whole ready check rather than self-deleting after 15s, because the
  // outcome is edited onto this same message. Announcing the pop and then posting a
  // separate "it failed" message put two notices in the queue channel for one event.
  const popNotice = await queueChannel.send({
    content: `Match #${match.match_id} → <#${textChannelId}> · Ready check in <#${readyCheckVc.id}> · closes ${closesAt}`,
  }).catch(() => null);

  /** Replaces the pop notice with how it ended, then clears it shortly after. */
  const closePopNotice = async (outcome?: string) => {
    if (!popNotice) return;
    if (outcome) {
      await popNotice.edit({ content: outcome }).catch(() => null);
      setTimeout(() => popNotice.delete().catch(() => null), 15_000);
    } else {
      await popNotice.delete().catch(() => null);
    }
  };

  const timer = setInterval(async () => {
    const elapsed = Math.floor((Date.now() - readyCheckStartedAt) / 1000);
    const currentQueue = getQueue(textChannelId);
    if (!currentQueue || currentQueue.state !== 'READY_CHECK') {
      // Cancelled or advanced from somewhere else -- take the notice with it rather than
      // leaving the queue channel pointing at a ready check that is no longer running.
      clearInterval(timer);
      await closePopNotice();
      return;
    }

    const vc = await guild.channels.fetch(readyCheckVc.id).catch(() => null);
    if (!vc || vc.type !== ChannelType.GuildVoice) {
      clearInterval(timer);
      await closePopNotice();
      return;
    }

    const allReady = currentQueue.player_ids.every(id => {
      if (id.startsWith('test_bot_')) return true;
      return vc.members.has(id);
    });

    if (allReady) {
      clearInterval(timer);
      // The match is under way; the queue channel no longer needs to point at it.
      await closePopNotice();
      if (readyMsg) {
        // Drop the ready-check card too -- it is a snapshot of a check that has passed.
        await readyMsg.edit({
          content: '✅ All players ready',
          files: [],
          attachments: [],
        }).catch(() => null);
      }

      currentQueue.state = 'VOTING';
      currentQueue.vote_counts = { captains: [], balanced: [], random: [] };
      saveQueue(currentQueue);

      await startVotingPhase(client, channelId, guildId, currentQueue, readyCheckVc.id, match, textChannelId);
      return;
    }

    if (elapsed % 6 === 0 && readyMsg) {
      const players = getPlayersByIds(currentQueue.guild_id, currentQueue.team_size, currentQueue.player_ids);
      const readyIds = Array.from(vc.members.keys());
      const readyImg = await generateReadyCheckImage(client, players, readyIds, teamSize);
      const attachment = new AttachmentBuilder(readyImg, { name: 'ready_check.png' });
      await readyMsg.edit({
        files: [attachment],
      }).catch(() => null);
    }

    if (elapsed >= timeoutSeconds) {
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
          content: `❌ Ready check failed — no voice from ${afkMentions || 'Unknown'}. Closing in 5s.`,
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

      if (combinedIds.length >= rosterSize) {
        const nextMatchIds = combinedIds.slice(0, rosterSize);
        const remainingIds = combinedIds.slice(rosterSize);

        rankQueue.player_ids = remainingIds;
        rankQueue.player_join_times = {};
        for (const id of remainingIds) {
          rankQueue.player_join_times[id] = combinedJoinTimes[id];
        }
        saveQueue(rankQueue);
        await refreshQueuePanel(client, channelId);

        await closePopNotice(
          `❌ Match #${match.match_id} ready check failed — removed ${afkMentions || 'Unknown'}. Queue re-popped (${rosterSize}/${rosterSize}).`
        );

        const popQueue: ActiveQueue = {
          channel_id: channelId,
          guild_id: guildId,
          team_size: teamSize,
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

        await closePopNotice(
          `❌ Match #${match.match_id} ready check failed — removed ${afkMentions || 'Unknown'}. Queue is ${rankQueue.player_ids.length}/${rosterSize}.`
        );
      }

      setTimeout(() => {
        vc.delete('AFK Ready check failed').catch(() => null);
        deleteMatchChannels(client, match.match_id);
        deleteQueue(textChannelId);
      }, 5000);
    }
  }, 3000);
}
