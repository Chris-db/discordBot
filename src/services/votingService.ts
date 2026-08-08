import {
  Client,
  TextChannel,
  Message,
  AttachmentBuilder,
} from 'discord.js';
import {
  getQueue,
  saveQueue,
  mutateQueue,
  getPlayersByIds,
  createMatch,
  updateMatch,
  ActiveQueue,
  Match,
  Player,
} from '../database/queries';
import { createMatchChannels } from './channelService';
import {
  buildModeVoteEmbed,
  buildCaptainsVoteEmbed,
  buildTeamsVoteEmbed,
  buildCaptainsDraftEmbed,
} from '../ui/embeds';
import {
  getModeVoteButtons,
  getCaptainsVoteButtons,
  getTeamsVoteButtons,
} from '../ui/buttons';
import { getCaptainsDraftSelectMenu } from '../ui/selectMenus';
import {
  createBalancedTeams,
  createRandomTeams,
  initializeCaptainsDraftWithCaptains,
  randomizeCaptains,
  processCaptainPick,
} from './draftService';
import { votesRequiredFor } from './gameRules';
import { totalPicks } from './draftService';
import { startNewMatch } from './matchService';
import { generateCaptainsDraftImage } from './draftImage';
import { generateModeVoteImage } from './voteImage';
import { logger } from '../utils/logger';
import config from '../config';
import { refreshQueuePanel, resetQueueAfterPop } from './queuePanel';

// Track active voting timers in memory so we don't duplicate timeouts
const activeVoteTimers = new Map<string, NodeJS.Timeout>();

/**
 * Starts the mode voting phase once the queue is full.
 */
export async function startVotingPhase(
  client: Client,
  channelId: string,
  guildId: string,
  queue: ActiveQueue,
  readyCheckVcId?: string,
  existingMatch?: Match,
  existingTextChannelId?: string
): Promise<void> {
  // 1. Create SQLite match record (or use existing from ready check)
  const match = existingMatch || createMatch({
    guild_id: guildId,
    channel_id: channelId,
    team_size: queue.team_size,
    state: 'VOTING',
    blue_team: [...queue.player_ids],
    orange_team: [],
    rl_name: '',
    rl_pass: '',
  });

  if (existingMatch) {
    updateMatch(match.match_id, { state: 'VOTING' });
  }

  // 2. Create temporary private text & voice channels (or use existing from ready check)
  let textChannelId = existingTextChannelId;
  if (!textChannelId) {
    const res = await createMatchChannels(
      client,
      guildId,
      match.match_id,
      queue.player_ids,
      channelId
    );
    textChannelId = res.textChannelId;
  }

  // 3. Create a temporary active queue entry for #match-ID so voting & drafting works inside it
  const matchQueue: ActiveQueue = {
    channel_id: textChannelId,
    guild_id: guildId,
    team_size: queue.team_size,
    player_ids: [...queue.player_ids],
    state: 'VOTING',
    ready_check_vc_id: readyCheckVcId || queue.ready_check_vc_id,
    vote_counts: { captains: [], balanced: [], random: [] },
  };
  saveQueue(matchQueue);

  // 4. Immediately reset the original rank queue channel if it hasn't been reset already!
  const rankQueue = getQueue(channelId);
  if (rankQueue && rankQueue.state !== 'WAITING') {
    rankQueue.player_ids = [];
    rankQueue.player_join_times = {};
    rankQueue.state = 'WAITING';
    rankQueue.vote_counts = {};
    rankQueue.draft_state = undefined;
    rankQueue.ready_check_vc_id = undefined;
    saveQueue(rankQueue);
    await refreshQueuePanel(client, channelId);
  }

  // 5. Send Mode Voting message inside the new private #match-ID channel
  const matchChan = (await client.channels.fetch(textChannelId)) as TextChannel;
  if (!matchChan) return;

  const players = getPlayersByIds(matchQueue.guild_id, matchQueue.team_size, matchQueue.player_ids);
  const voteCounts = { captains: 0, balanced: 0, random: 0 };

  const voteImg = await generateModeVoteImage(players, voteCounts);
  const attachment = new AttachmentBuilder(voteImg, { name: 'voting_mode.png' });

  const embed = buildModeVoteEmbed(players, voteCounts, votesRequiredFor(players.map(p => p.discord_id)));
  embed.setImage('attachment://voting_mode.png');
  const buttons = getModeVoteButtons(voteCounts);

  const mentions = players
    .filter(p => !p.discord_id.startsWith('test_bot_'))
    .map(p => `<@${p.discord_id}>`)
    .join(' ');

  const voteMsg = await matchChan.send({
    content: `🔔 **QUEUE POPPED! Welcome to Match #${match.match_id}** ${mentions}`,
    embeds: [embed],
    components: [buttons],
    files: [attachment],
  });

  updateMatch(match.match_id, {
    message_id: voteMsg.id,
    queue_channel_id: channelId,
  });

  // Start 30 second countdown
  const timer = setTimeout(async () => {
    activeVoteTimers.delete(textChannelId);
    await finalizeVoteAndPop(client, textChannelId, guildId, voteMsg);
  }, 30_000);

  activeVoteTimers.set(textChannelId, timer);
}

/**
 * Handles player vote clicks.
 */
export async function handleModeVote(
  client: Client,
  channelId: string,
  guildId: string,
  userId: string,
  votedMode: 'captains' | 'balanced' | 'random',
  message: Message
): Promise<{ success: boolean; message: string }> {
  // Atomic — concurrent clicks used to clobber each other's votes.
  let rejection: string | undefined;
  const queue = mutateQueue(channelId, q => {
    if (q.state !== 'VOTING') {
      rejection = 'Voting is not currently active.';
      return;
    }
    if (!q.player_ids.includes(userId)) {
      rejection = 'Only queued players can vote!';
      return;
    }

    // Remove existing vote by this user if any
    for (const mode of ['captains', 'balanced', 'random'] as const) {
      const list = q.vote_counts[mode] || [];
      q.vote_counts[mode] = list.filter(id => id !== userId);
    }

    // Record new vote
    q.vote_counts[votedMode].push(userId);
  });

  if (!queue) {
    return { success: false, message: 'Voting is not currently active.' };
  }
  if (rejection) {
    return { success: false, message: rejection };
  }

  const voteCounts = {
    captains: (queue.vote_counts.captains || []).length,
    balanced: (queue.vote_counts.balanced || []).length,
    random: (queue.vote_counts.random || []).length,
  };

  const players = getPlayersByIds(queue.guild_id, queue.team_size, queue.player_ids);
  const voteImg = await generateModeVoteImage(players, voteCounts);
  const attachment = new AttachmentBuilder(voteImg, { name: 'voting_mode.png' });
  const embed = buildModeVoteEmbed(players, voteCounts, votesRequiredFor(players.map(p => p.discord_id)));
  embed.setImage('attachment://voting_mode.png');

  await message.edit({
    embeds: [embed],
    components: [getModeVoteButtons(voteCounts)],
    files: [attachment],
  });

  // Once a majority of the lobby agrees on a mode, resolve immediately.
  if (voteCounts[votedMode] >= votesRequiredFor(queue.player_ids)) {
    const timer = activeVoteTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      activeVoteTimers.delete(channelId);
    }
    await finalizeVoteAndPop(client, channelId, guildId, message);
  }

  return { success: true, message: `Voted for **${votedMode.toUpperCase()}**!` };
}

export type TeamMode = 'captains' | 'balanced' | 'random';

/**
 * Picks the winning mode from the vote tally, breaking ties with a coin flip.
 *
 * The old rule was a fixed priority (balanced > captains > random), which meant balanced
 * won every tie -- including 0-0-0, where nobody voted at all. Captains could only win
 * with a strict majority, so a group that prefers captains would reasonably conclude the
 * vote was rigged.
 */
export function resolveWinningMode(counts: Record<TeamMode, number>): {
  winningMode: TeamMode;
  tiedModes: TeamMode[];
  maxVotes: number;
} {
  const modes: TeamMode[] = ['captains', 'balanced', 'random'];
  const maxVotes = Math.max(...modes.map(m => counts[m]));
  const tiedModes = modes.filter(m => counts[m] === maxVotes);

  // Nobody voted at all: that's not a tie, it's an absent lobby. Coin-flipping it into a
  // captains draft would ask an unresponsive queue to keep making picks, so take the mode
  // that needs no further input.
  if (maxVotes === 0) {
    return { winningMode: 'balanced', tiedModes: ['balanced'], maxVotes };
  }

  const winningMode = tiedModes[Math.floor(Math.random() * tiedModes.length)];
  return { winningMode, tiedModes, maxVotes };
}

/**
 * Determines the winning mode and executes the queue pop.
 */
export async function finalizeVoteAndPop(
  client: Client,
  channelId: string,
  guildId: string,
  voteMsg?: Message
): Promise<void> {
  const queue = getQueue(channelId);
  if (!queue || queue.state !== 'VOTING') return;

  const counts = {
    captains: (queue.vote_counts.captains || []).length,
    balanced: (queue.vote_counts.balanced || []).length,
    random: (queue.vote_counts.random || []).length,
  };

  const { winningMode, tiedModes, maxVotes } = resolveWinningMode(counts);

  logger.info(
    `Channel ${channelId} queue voting ended. Winning mode: ${winningMode}` +
      (tiedModes.length > 1
        ? ` (coin flip between ${tiedModes.join(', ')} at ${maxVotes} vote(s) each)`
        : '')
  );

  if (voteMsg) {
    const tiebreakNote =
      tiedModes.length > 1
        ? `\n🎲 Tied at ${maxVotes} vote${maxVotes === 1 ? '' : 's'} (${tiedModes
            .map(m => m.toUpperCase())
            .join(' vs ')}) — decided by coin flip.`
        : '';
    await voteMsg.edit({
      content: `✅ **VOTING COMPLETE!** Winning mode: **${winningMode.toUpperCase()}**${tiebreakNote}`,
      components: [],
    }).catch(() => null);
  }

  if (winningMode === 'balanced' || winningMode === 'random') {
    await startTeamsVotePhase(client, channelId, guildId, queue, winningMode);
  } else if (winningMode === 'captains') {
    await startCaptainsVotePhase(client, channelId, guildId, queue, false);
  }
}

/**
 * Starts or restarts the Captain Verification vote phase.
 */
export async function startCaptainsVotePhase(
  client: Client,
  channelId: string,
  guildId: string,
  queue: ActiveQueue,
  isRandomize: boolean = false,
  messageToEdit?: Message
): Promise<void> {
  const players = getPlayersByIds(queue.guild_id, queue.team_size, queue.player_ids);
  let blueCaptain: Player;
  let orangeCaptain: Player;

  if (isRandomize) {
    const seenPairs = queue.captain_vote_state?.seenCaptainPairs || [];
    const res = randomizeCaptains(
      players,
      queue.captain_vote_state?.blueCaptain,
      queue.captain_vote_state?.orangeCaptain,
      seenPairs
    );
    blueCaptain = res.blueCaptain;
    orangeCaptain = res.orangeCaptain;
    const newSeenPairs =
      seenPairs.length >= 15 ? [res.pairKey] : [...seenPairs, res.pairKey];

    queue.state = 'CAPTAINS_VOTE';
    queue.captain_vote_state = {
      blueCaptain: blueCaptain.discord_id,
      orangeCaptain: orangeCaptain.discord_id,
      yesVotes: [],
      noVotes: [],
      seenCaptainPairs: newSeenPairs,
    };
  } else {
    const sorted = [...players].sort((a, b) => b.mmr - a.mmr);
    blueCaptain = sorted[0];
    orangeCaptain = sorted[1];

    queue.state = 'CAPTAINS_VOTE';
    queue.captain_vote_state = {
      blueCaptain: blueCaptain.discord_id,
      orangeCaptain: orangeCaptain.discord_id,
      yesVotes: [],
      noVotes: [],
      seenCaptainPairs: [],
    };
  }
  saveQueue(queue);

  const channel = (await client.channels.fetch(channelId)) as TextChannel;
  if (!channel) return;

  const embed = buildCaptainsVoteEmbed(blueCaptain, orangeCaptain, 0, 0);
  const buttons = getCaptainsVoteButtons({ yes: 0, no: 0 });

  let sentMsg: Message;
  if (messageToEdit) {
    sentMsg = await messageToEdit.edit({
      content: `👑 **CAPTAIN VERIFICATION VOTE** — Please verify if you want to proceed with these captains:`,
      embeds: [embed],
      components: [buttons],
    }).catch(async () => {
      return await channel.send({
        content: `👑 **CAPTAIN VERIFICATION VOTE** — Please verify if you want to proceed with these captains:`,
        embeds: [embed],
        components: [buttons],
      });
    });
  } else {
    sentMsg = await channel.send({
      content: `👑 **CAPTAIN VERIFICATION VOTE** — Please verify if you want to proceed with these captains:`,
      embeds: [embed],
      components: [buttons],
    });
  }

  queue.captain_vote_state.message_id = sentMsg.id;
  saveQueue(queue);

  if (activeVoteTimers.has(channelId)) {
    clearTimeout(activeVoteTimers.get(channelId)!);
    activeVoteTimers.delete(channelId);
  }

  const allBots = queue.player_ids.every(id => id.startsWith('test_bot_'));
  if (allBots) {
    const timer = setTimeout(async () => {
      activeVoteTimers.delete(channelId);
      await finalizeCaptainsVote(client, channelId, guildId, sentMsg, true);
    }, 1500);
    activeVoteTimers.set(channelId, timer);
    return;
  }

  const timer = setTimeout(async () => {
    activeVoteTimers.delete(channelId);
    await finalizeCaptainsVote(client, channelId, guildId, sentMsg);
  }, 30_000);

  activeVoteTimers.set(channelId, timer);
}

/**
 * Handles player Captain Verification vote clicks (yes / no).
 */
export async function handleCaptainsVote(
  client: Client,
  channelId: string,
  guildId: string,
  userId: string,
  vote: 'yes' | 'no',
  message: Message
): Promise<{ success: boolean; message: string }> {
  let rejection: string | undefined;
  const queue = mutateQueue(channelId, q => {
    if (q.state !== 'CAPTAINS_VOTE' || !q.captain_vote_state) {
      rejection = 'Captain verification is not currently active.';
      return;
    }
    if (!q.player_ids.includes(userId)) {
      rejection = 'Only queued players can vote on captains!';
      return;
    }

    q.captain_vote_state.yesVotes = q.captain_vote_state.yesVotes.filter(id => id !== userId);
    q.captain_vote_state.noVotes = q.captain_vote_state.noVotes.filter(id => id !== userId);

    if (vote === 'yes') {
      q.captain_vote_state.yesVotes.push(userId);
    } else {
      q.captain_vote_state.noVotes.push(userId);
    }
  });

  if (!queue || !queue.captain_vote_state) {
    return { success: false, message: 'Captain verification is not currently active.' };
  }
  if (rejection) {
    return { success: false, message: rejection };
  }

  const yesCount = queue.captain_vote_state.yesVotes.length;
  const noCount = queue.captain_vote_state.noVotes.length;

  const blueCaptain = getPlayersByIds(queue.guild_id, queue.team_size, [queue.captain_vote_state.blueCaptain])[0];
  const orangeCaptain = getPlayersByIds(queue.guild_id, queue.team_size, [queue.captain_vote_state.orangeCaptain])[0];

  const embed = buildCaptainsVoteEmbed(blueCaptain, orangeCaptain, yesCount, noCount);
  const buttons = getCaptainsVoteButtons({ yes: yesCount, no: noCount });

  await message.edit({
    embeds: [embed],
    components: [buttons],
  });

  if (yesCount >= 4 || noCount >= 4) {
    const timer = activeVoteTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      activeVoteTimers.delete(channelId);
    }
    await finalizeCaptainsVote(client, channelId, guildId, message);
  }

  return {
    success: true,
    message: vote === 'yes' ? 'Voted **YES** to proceed with these captains!' : 'Voted **NO** to randomize captains!',
  };
}

/**
 * Resolves the Captain Verification vote.
 */
export async function finalizeCaptainsVote(
  client: Client,
  channelId: string,
  guildId: string,
  message?: Message,
  allBots?: boolean
): Promise<void> {
  const queue = getQueue(channelId);
  if (!queue || queue.state !== 'CAPTAINS_VOTE' || !queue.captain_vote_state) return;

  const yesCount = queue.captain_vote_state.yesVotes.length;
  const noCount = queue.captain_vote_state.noVotes.length;

  if (!allBots && noCount > yesCount) {
    logger.info(`Channel ${channelId} captains vote rejected. Randomizing new captains...`);
    if (message) {
      await message.edit({
        content: `🔄 **CAPTAINS REJECTED!** Randomizing new captains...`,
        components: [],
      }).catch(() => null);
    }
    await startCaptainsVotePhase(client, channelId, guildId, queue, true, message);
  } else {
    logger.info(`Channel ${channelId} captains vote approved.`);
    if (message) {
      await message.edit({
        content: `✅ **CAPTAINS APPROVED!** Starting Captains Draft...`,
        components: [],
      }).catch(() => null);
    }

    const blueCapId = queue.captain_vote_state.blueCaptain;
    const orangeCapId = queue.captain_vote_state.orangeCaptain;
    const players = getPlayersByIds(queue.guild_id, queue.team_size, queue.player_ids);

    queue.state = 'DRAFTING';
    queue.draft_state = initializeCaptainsDraftWithCaptains(players, blueCapId, orangeCapId);
    queue.captain_vote_state = undefined;
    saveQueue(queue);

    await sendCaptainsDraftCard(client, channelId, queue);
  }
}

/**
 * Starts or restarts the Team Verification vote phase for Random / Balanced Teams.
 * When asked if teams are valid, voting "No, Randomize" calls this with isRandomize = true,
 * using Option 2 (exhaustive no-repeat generation until all 10 combinations are seen).
 */
export async function startTeamsVotePhase(
  client: Client,
  channelId: string,
  guildId: string,
  queue: ActiveQueue,
  mode: 'random' | 'balanced' = 'random',
  messageToEdit?: Message
): Promise<void> {
  const players = getPlayersByIds(queue.guild_id, queue.team_size, queue.player_ids);

  // seenMatchups carries the re-roll history, so both generators walk to a new matchup
  // rather than repeating one the queue has already rejected.
  const seenMatchups = queue.team_vote_state?.seenMatchups || [];

  const { blueTeam, orangeTeam, matchupKey } =
    mode === 'balanced'
      ? createBalancedTeams(players, seenMatchups)
      : createRandomTeams(players, seenMatchups);

  const newSeen = seenMatchups.length >= 10 ? [matchupKey!] : [...seenMatchups, matchupKey!];

  queue.state = 'TEAMS_VOTE';
  queue.team_vote_state = {
    blueTeam: blueTeam.map(p => p.discord_id),
    orangeTeam: orangeTeam.map(p => p.discord_id),
    yesVotes: [],
    noVotes: [],
    seenMatchups: newSeen,
    mode,
  };
  saveQueue(queue);

  const channel = (await client.channels.fetch(channelId)) as TextChannel;
  if (!channel) return;

  const embed = buildTeamsVoteEmbed(blueTeam, orangeTeam, 0, 0, newSeen.length, mode);
  const buttons = getTeamsVoteButtons({ yes: 0, no: 0 }, mode);

  let sentMsg: Message;
  if (messageToEdit) {
    sentMsg = await messageToEdit.edit({
      content: `🎲 **TEAM VERIFICATION VOTE** — Please verify if you want to proceed with these teams:`,
      embeds: [embed],
      components: [buttons],
    }).catch(async () => {
      return await channel.send({
        content: `🎲 **TEAM VERIFICATION VOTE** — Please verify if you want to proceed with these teams:`,
        embeds: [embed],
        components: [buttons],
      });
    });
  } else {
    sentMsg = await channel.send({
      content: `🎲 **TEAM VERIFICATION VOTE** — Please verify if you want to proceed with these teams:`,
      embeds: [embed],
      components: [buttons],
    });
  }

  queue.team_vote_state.message_id = sentMsg.id;
  saveQueue(queue);

  if (activeVoteTimers.has(channelId)) {
    clearTimeout(activeVoteTimers.get(channelId)!);
    activeVoteTimers.delete(channelId);
  }

  const allBots = queue.player_ids.every(id => id.startsWith('test_bot_'));
  if (allBots) {
    const timer = setTimeout(async () => {
      activeVoteTimers.delete(channelId);
      await finalizeTeamsVote(client, channelId, guildId, sentMsg, true);
    }, 1500);
    activeVoteTimers.set(channelId, timer);
    return;
  }

  const timer = setTimeout(async () => {
    activeVoteTimers.delete(channelId);
    await finalizeTeamsVote(client, channelId, guildId, sentMsg);
  }, 30_000);

  activeVoteTimers.set(channelId, timer);
}

/**
 * Handles player Team Verification vote clicks (yes / no).
 */
export async function handleTeamsVote(
  client: Client,
  channelId: string,
  guildId: string,
  userId: string,
  vote: 'yes' | 'no',
  message: Message
): Promise<{ success: boolean; message: string }> {
  let rejection: string | undefined;
  const queue = mutateQueue(channelId, q => {
    if (q.state !== 'TEAMS_VOTE' || !q.team_vote_state) {
      rejection = 'Team verification is not currently active.';
      return;
    }
    if (!q.player_ids.includes(userId)) {
      rejection = 'Only queued players can vote on teams!';
      return;
    }

    q.team_vote_state.yesVotes = q.team_vote_state.yesVotes.filter(id => id !== userId);
    q.team_vote_state.noVotes = q.team_vote_state.noVotes.filter(id => id !== userId);

    if (vote === 'yes') {
      q.team_vote_state.yesVotes.push(userId);
    } else {
      q.team_vote_state.noVotes.push(userId);
    }
  });

  if (!queue || !queue.team_vote_state) {
    return { success: false, message: 'Team verification is not currently active.' };
  }
  if (rejection) {
    return { success: false, message: rejection };
  }

  const yesCount = queue.team_vote_state.yesVotes.length;
  const noCount = queue.team_vote_state.noVotes.length;
  const seenCount = queue.team_vote_state.seenMatchups?.length || 1;

  const blueTeam = getPlayersByIds(queue.guild_id, queue.team_size, queue.team_vote_state.blueTeam);
  const orangeTeam = getPlayersByIds(queue.guild_id, queue.team_size, queue.team_vote_state.orangeTeam);

  const mode = queue.team_vote_state.mode || 'random';
  const embed = buildTeamsVoteEmbed(blueTeam, orangeTeam, yesCount, noCount, seenCount, mode);
  const buttons = getTeamsVoteButtons({ yes: yesCount, no: noCount }, mode);

  await message.edit({
    embeds: [embed],
    components: [buttons],
  });

  if (yesCount >= 4 || noCount >= 4) {
    const timer = activeVoteTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      activeVoteTimers.delete(channelId);
    }
    await finalizeTeamsVote(client, channelId, guildId, message);
  }

  return {
    success: true,
    message:
      vote === 'yes'
        ? 'Voted **YES** to proceed with these teams!'
        : `Voted **NO** — re-roll for the ${
            mode === 'balanced' ? 'next-closest balanced split' : 'next random matchup'
          }!`,
  };
}

/**
 * Resolves the Team Verification vote.
 */
export async function finalizeTeamsVote(
  client: Client,
  channelId: string,
  guildId: string,
  message?: Message,
  allBots?: boolean
): Promise<void> {
  const queue = getQueue(channelId);
  if (!queue || queue.state !== 'TEAMS_VOTE' || !queue.team_vote_state) return;

  const yesCount = queue.team_vote_state.yesVotes.length;
  const noCount = queue.team_vote_state.noVotes.length;

  if (!allBots && noCount > yesCount) {
    // Re-roll in the mode the queue actually voted for. This used to hardcode a random
    // re-roll, so voting Balanced and then rejecting the split silently handed back
    // random teams. Rows written before mode was persisted default to random.
    const mode = queue.team_vote_state.mode || 'random';
    logger.info(
      `Channel ${channelId} team verification vote rejected. Generating next ${mode} matchup without repeat...`
    );
    if (message) {
      const rerollLabel =
        mode === 'balanced' ? 'next-closest balanced split' : 'new random matchup';
      await message.edit({
        content: `🔄 **TEAMS REJECTED** (${noCount} NO vs ${yesCount} YES). Generating a ${rerollLabel}...`,
        components: [],
      }).catch(() => null);
    }

    await startTeamsVotePhase(client, channelId, guildId, queue, mode, message);
  } else {
    logger.info(`Channel ${channelId} team verification vote approved. Starting match (teams locked in)...`);
    if (message) {
      await message.edit({
        content: `✅ **TEAMS APPROVED!** (Teams are now locked in). Launching match...`,
        components: [],
      }).catch(() => null);
    }

    const blueTeam = getPlayersByIds(queue.guild_id, queue.team_size, queue.team_vote_state.blueTeam);
    const orangeTeam = getPlayersByIds(queue.guild_id, queue.team_size, queue.team_vote_state.orangeTeam);

    await startNewMatch(client, guildId, channelId, blueTeam, orangeTeam);
    resetQueueAfterPop(client, channelId);
  }
}

/**
 * Sends or updates the Captains Draft card in the channel.
 */
export async function sendCaptainsDraftCard(
  client: Client,
  channelId: string,
  queue: ActiveQueue
): Promise<void> {
  const channel = (await client.channels.fetch(channelId)) as TextChannel;
  if (!channel || !queue.draft_state) return;

  const draft = queue.draft_state;
  const blueCaptain = getPlayersByIds(queue.guild_id, queue.team_size, [draft.blueCaptain])[0];
  const orangeCaptain = getPlayersByIds(queue.guild_id, queue.team_size, [draft.orangeCaptain])[0];
  const blueTeam = getPlayersByIds(queue.guild_id, queue.team_size, draft.blueTeam);
  const orangeTeam = getPlayersByIds(queue.guild_id, queue.team_size, draft.orangeTeam);
  const remaining = getPlayersByIds(queue.guild_id, queue.team_size, draft.remainingPlayers);

  const teamSize = draft.teamSize ?? queue.team_size;
  const picks = totalPicks(teamSize);

  const draftImg = await generateCaptainsDraftImage(
    client,
    blueCaptain,
    orangeCaptain,
    blueTeam,
    orangeTeam,
    remaining,
    draft.turn,
    draft.pickNumber,
    teamSize
  );
  const attachment = new AttachmentBuilder(draftImg, { name: 'captains_draft.png' });

  const embed = buildCaptainsDraftEmbed(
    blueCaptain,
    orangeCaptain,
    blueTeam,
    orangeTeam,
    remaining,
    draft.turn,
    draft.pickNumber,
    picks
  );
  embed.setImage('attachment://captains_draft.png');

  const selectMenu = getCaptainsDraftSelectMenu(
    remaining,
    draft.pickNumber,
    draft.turn,
    picks
  );

  const sentMsg = await channel.send({
    content: `👑 **CAPTAINS DRAFT IN PROGRESS** | Turn: <@${
      draft.turn === 'BLUE' ? draft.blueCaptain : draft.orangeCaptain
    }>`,
    embeds: [embed],
    components: [selectMenu],
    files: [attachment],
  });

  const currentCaptain = draft.turn === 'BLUE' ? draft.blueCaptain : draft.orangeCaptain;
  if (currentCaptain.startsWith('test_bot_') && remaining.length > 0) {
    setTimeout(async () => {
      const sortedRemaining = [...remaining].sort((a, b) => b.mmr - a.mmr);
      const pick = sortedRemaining[0];
      if (pick) {
        await handleCaptainPick(client, channelId, currentCaptain, pick.discord_id, sentMsg);
      }
    }, 1500);
    return;
  }

  // An AFK captain used to hang the draft forever — there was no clock on a pick at all.
  // Auto-pick the highest-MMR player left if this pick hasn't been made in time.
  if (remaining.length > 0) {
    const existing = activeVoteTimers.get(channelId);
    if (existing) clearTimeout(existing);

    const pickNumberAtSend = draft.pickNumber;
    const timer = setTimeout(async () => {
      activeVoteTimers.delete(channelId);

      const current = getQueue(channelId);
      if (
        !current ||
        current.state !== 'DRAFTING' ||
        !current.draft_state ||
        current.draft_state.pickNumber !== pickNumberAtSend
      ) {
        return; // the pick was made, or the draft moved on
      }

      const stillRemaining = getPlayersByIds(current.guild_id, current.team_size, current.draft_state.remainingPlayers);
      const autoPick = [...stillRemaining].sort((a, b) => b.mmr - a.mmr)[0];
      if (!autoPick) return;

      logger.info(
        `Draft pick #${pickNumberAtSend} in ${channelId} timed out. Auto-picking ${autoPick.username}.`
      );
      await sentMsg
        .reply({ content: `⏰ <@${currentCaptain}> ran out of time — auto-picking **${autoPick.username}**.` })
        .catch(() => null);

      await handleCaptainPick(client, channelId, currentCaptain, autoPick.discord_id, sentMsg).catch(
        err => logger.error('Draft auto-pick failed:', err)
      );
    }, (config.draftPickTimeoutSeconds || 90) * 1000);

    activeVoteTimers.set(channelId, timer);
  }
}

/**
 * Handles a Captain selecting a teammate from the select menu dropdown.
 */
export async function handleCaptainPick(
  client: Client,
  channelId: string,
  pickerId: string,
  selectedPlayerId: string,
  message: Message
): Promise<{ success: boolean; message: string }> {
  const queue = getQueue(channelId);
  if (!queue || queue.state !== 'DRAFTING' || !queue.draft_state) {
    return { success: false, message: 'No active draft in this channel.' };
  }

  try {
    queue.draft_state = processCaptainPick(queue.draft_state, pickerId, selectedPlayerId);
  } catch (error: any) {
    return { success: false, message: error.message || 'Invalid draft pick.' };
  }

  // The pick landed — stop the auto-pick clock for it.
  const pendingTimer = activeVoteTimers.get(channelId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    activeVoteTimers.delete(channelId);
  }

  saveQueue(queue);

  // Check if the draft is finished -- both sides full at whatever size this lobby is
  const draftTeamSize = queue.draft_state.teamSize ?? queue.team_size;
  if (
    queue.draft_state.blueTeam.length === draftTeamSize &&
    queue.draft_state.orangeTeam.length === draftTeamSize
  ) {
    const bluePlayers = getPlayersByIds(queue.guild_id, queue.team_size, queue.draft_state.blueTeam);
    const orangePlayers = getPlayersByIds(queue.guild_id, queue.team_size, queue.draft_state.orangeTeam);

    await message.edit({
      content: '✅ **CAPTAINS DRAFT COMPLETED!** Launching match...',
      components: [],
    }).catch(() => null);

    await startNewMatch(client, queue.guild_id, channelId, bluePlayers, orangePlayers);
    resetQueueAfterPop(client, channelId);
    return { success: true, message: 'Draft complete!' };
  } else {
    // Send updated draft card
    await message.delete().catch(() => null);
    await sendCaptainsDraftCard(client, channelId, queue);
    return { success: true, message: 'Pick recorded!' };
  }
}
