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
import { getReadyCheckButtons } from '../ui/buttons';

/**
 * Ready checks that are still running, by match id, so the Not-ready button can reach the
 * one it belongs to. A check registers itself when its timer starts and drops out when it
 * ends by any route. Nothing survives a restart, which is fine: the startup recovery
 * cancels every match that was mid-check.
 */
const runningReadyChecks = new Map<
  number,
  { playerIds: string[]; fail: (afkPlayerIds: string[], why: string) => Promise<boolean> }
>();

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
      components: [getReadyCheckButtons(match.match_id)],
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

  // One gate for every way the check can end: all ready, timed out, someone walked out,
  // or cancelled from elsewhere. The Not-ready button and the timer can both reach the
  // fail path, and two overlapping ticks could both see everyone in voice, so whichever
  // gets here first owns the transition and the rest return without doing anything.
  let ended = false;
  let timer: NodeJS.Timeout | undefined;
  const endCheck = (): boolean => {
    if (ended) return false;
    ended = true;
    if (timer) clearInterval(timer);
    runningReadyChecks.delete(match.match_id);
    return true;
  };

  /**
   * Fails the check with `afkPlayerIds` as the ones who did not show up. Everyone else
   * goes back to the front of the rank queue (re-popping it if enough are waiting), the
   * channels come down, and the pop notice is edited with the outcome.
   *
   * Returns false if the check had already ended by another route.
   */
  const failReadyCheck = async (afkPlayerIds: string[], why: string): Promise<boolean> => {
    if (!endCheck()) return false;

    const currentQueue = getQueue(textChannelId);
    if (!currentQueue || currentQueue.state !== 'READY_CHECK') {
      // Cancelled from elsewhere since the last tick; whoever did that released the players.
      await closePopNotice();
      return false;
    }
    const readyPlayerIds = currentQueue.player_ids.filter(id => !afkPlayerIds.includes(id));

    updateMatch(match.match_id, {
      state: 'CANCELLED',
      winner: 'NONE',
      completed_at: new Date().toISOString(),
    });
    // A queue cooldown for `afkPlayerIds` would go here, if the server ever wants one.

    if (matchTextChannel) {
      await matchTextChannel.send({
        content: `❌ Ready check failed — ${why}. Closing in 5s.`,
      }).catch(() => null);
    }

    const { rePopped, waiting } = await returnPlayersToQueue(
      client,
      channelId,
      guildId,
      readyPlayerIds,
      currentQueue.player_join_times
    );

    const afkMentions = afkPlayerIds.map(id => `<@${id}>`).join(', ');
    await closePopNotice(
      rePopped
        ? `❌ Match #${match.match_id} ready check failed — removed ${afkMentions}. Queue re-popped (${rosterSize}/${rosterSize}).`
        : `❌ Match #${match.match_id} ready check failed — removed ${afkMentions}. Queue is ${waiting}/${rosterSize}.`
    );

    setTimeout(() => {
      readyCheckVc.delete('Ready check failed').catch(() => null);
      deleteMatchChannels(client, match.match_id);
      deleteQueue(textChannelId);
    }, 5000);
    return true;
  };

  runningReadyChecks.set(match.match_id, {
    playerIds: [...matchQueue.player_ids],
    fail: failReadyCheck,
  });

  const tick = async () => {
    const elapsed = Math.floor((Date.now() - readyCheckStartedAt) / 1000);
    const currentQueue = getQueue(textChannelId);
    if (!currentQueue || currentQueue.state !== 'READY_CHECK') {
      // Cancelled or advanced from somewhere else -- take the notice with it rather than
      // leaving the queue channel pointing at a ready check that is no longer running.
      if (endCheck()) await closePopNotice();
      return;
    }

    const vc = await guild.channels.fetch(readyCheckVc.id).catch(() => null);
    if (!vc || vc.type !== ChannelType.GuildVoice) {
      if (endCheck()) await closePopNotice();
      return;
    }

    const allReady = currentQueue.player_ids.every(id => {
      if (id.startsWith('test_bot_')) return true;
      return vc.members.has(id);
    });

    if (allReady) {
      if (!endCheck()) return;
      // The match is under way; the queue channel no longer needs to point at it.
      await closePopNotice();
      if (readyMsg) {
        // Drop the ready-check card too -- it is a snapshot of a check that has passed.
        await readyMsg.edit({
          content: '✅ All players ready',
          files: [],
          attachments: [],
          components: [],
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
      const afkPlayerIds = currentQueue.player_ids.filter(id => {
        if (id.startsWith('test_bot_')) return false;
        return !vc.members.has(id);
      });
      const afkMentions = afkPlayerIds.map(id => `<@${id}>`).join(', ');
      await failReadyCheck(afkPlayerIds, `no voice from ${afkMentions || 'Unknown'}`);
    }
  };

  timer = setInterval(() => {
    if (ended) return;
    tick().catch(err => logger.error(`Ready check tick for Match #${match.match_id} failed:`, err));
  }, 3000);
}

/**
 * Puts the players who did show up back at the front of the rank queue, ahead of anyone
 * who joined while the check ran, and pops it again if that makes a full lobby.
 *
 * Call this after the failed match has been cancelled: until then its players still count
 * as mid-match, and the backstop in startReadyCheckPhase would drop every one of them.
 */
export async function returnPlayersToQueue(
  client: Client,
  channelId: string,
  guildId: string,
  playerIds: string[],
  joinTimes: Record<string, number> | undefined
): Promise<{ rePopped: boolean; waiting: number }> {
  const rankQueue = getOrInitQueue(channelId, guildId);
  const rosterSize = rankQueue.team_size * 2;

  const combinedIds: string[] = [];
  const combinedJoinTimes: Record<string, number> = {};
  for (const id of playerIds) {
    if (!combinedIds.includes(id)) {
      combinedIds.push(id);
      combinedJoinTimes[id] = joinTimes?.[id] || Date.now();
    }
  }
  for (const id of rankQueue.player_ids) {
    if (!combinedIds.includes(id)) {
      combinedIds.push(id);
      combinedJoinTimes[id] = rankQueue.player_join_times?.[id] || Date.now();
    }
  }

  const nextMatchIds = combinedIds.length >= rosterSize ? combinedIds.slice(0, rosterSize) : undefined;
  const remainingIds = nextMatchIds ? combinedIds.slice(rosterSize) : combinedIds;

  rankQueue.player_ids = remainingIds;
  rankQueue.player_join_times = {};
  for (const id of remainingIds) {
    rankQueue.player_join_times[id] = combinedJoinTimes[id];
  }
  saveQueue(rankQueue);
  await refreshQueuePanel(client, channelId);

  if (!nextMatchIds) {
    return { rePopped: false, waiting: remainingIds.length };
  }

  const popQueue: ActiveQueue = {
    channel_id: channelId,
    guild_id: guildId,
    team_size: rankQueue.team_size,
    player_ids: nextMatchIds,
    player_join_times: {},
    state: 'WAITING',
    vote_counts: {},
  };
  for (const id of nextMatchIds) {
    popQueue.player_join_times![id] = combinedJoinTimes[id];
  }
  // The failed check still has channels to tear down after this returns, so a re-pop that
  // falls over must not take that with it. The stale-match sweep picks up what it left.
  try {
    await startReadyCheckPhase(client, channelId, guildId, popQueue);
  } catch (error) {
    logger.error(`Re-pop of ${channelId} after a failed ready check did not start:`, error);
  }
  return { rePopped: true, waiting: remainingIds.length };
}

/**
 * The Not-ready button. Fails the running check for `matchId` with the clicker as the
 * one AFK player, which is the same outcome as letting it time out with them missing.
 *
 * After a restart the registry is empty, so a click on a card from before it is refused
 * here; the startup recovery has already cancelled that match anyway.
 */
export async function handleReadyCheckLeave(
  matchId: number,
  userId: string
): Promise<{ success: boolean; message: string }> {
  const check = runningReadyChecks.get(matchId);
  if (!check) {
    return { success: false, message: 'No ready check is running for this match.' };
  }
  if (!check.playerIds.includes(userId)) {
    return { success: false, message: 'You are not in this ready check.' };
  }

  const failed = await check.fail([userId], `<@${userId}> is not ready`);
  if (!failed) {
    return { success: false, message: 'This ready check has already ended.' };
  }
  return { success: true, message: '🚪 You left the ready check. The others are back at the front of the queue.' };
}
