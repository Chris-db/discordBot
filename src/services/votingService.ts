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
import { buildCaptainsVoteEmbed, buildTeamsVoteEmbed } from '../ui/embeds';
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
  getCaptainPairKey,
  processCaptainPick,
} from './draftService';
import { votesRequiredFor, MAX_REROLLS } from './gameRules';
import { totalPicks, matchupCount, captainPairCount, describePickOrder } from './draftService';
import { startNewMatch } from './matchService';
import { generateCaptainsDraftImage } from './draftImage';
import { generateModeVoteImage } from './voteImage';
import { logger } from '../utils/logger';
import config from '../config';
import { refreshQueuePanel, resetQueueAfterPop } from './queuePanel';

// Track active voting timers in memory so we don't duplicate timeouts
const activeVoteTimers = new Map<string, NodeJS.Timeout>();

// Channels whose vote is being resolved right now.
const finalizing = new Set<string>();

/**
 * Runs a finalizer unless one is already running for this channel.
 *
 * Every finalizer checks the phase state synchronously, then awaits a message edit
 * before the next phase changes that state. A majority click landing in that gap passed
 * its own state check and resolved the vote a second time -- two Team Vote cards, one of
 * them dead. The check-and-add here is synchronous, which on a single thread is atomic.
 */
async function onceAtATime(channelId: string, run: () => Promise<void>): Promise<void> {
  if (finalizing.has(channelId)) return;
  finalizing.add(channelId);
  try {
    await run();
  } finally {
    finalizing.delete(channelId);
  }
}

const MODE_LABELS: Record<TeamMode, string> = {
  captains: 'Captains Draft',
  balanced: 'Balanced MMR',
  random: 'Random Teams',
};

/**
 * A deadline as a live Discord timestamp: `<t:…:R>` renders as "in 45 seconds" and ticks
 * on every viewer's screen without the bot editing anything.
 *
 * Every vote phase used to run on a hidden setTimeout. Nothing on the card said there was
 * a clock, or what silence would do when it ran out, so a lobby that was still arguing in
 * voice found its teams locked. The deadline is computed from the same Date.now() the
 * timer is armed from, so the two agree to the second.
 */
function relativeTimestamp(atMs: number): string {
  return `<t:${Math.floor(atMs / 1000)}:R>`;
}

/**
 * Re-rolls used so far, read off the showing history: the first entry is what the lobby
 * was first shown, every entry after it is a rejection.
 */
function rerollsUsed(seen: string[] | undefined): number {
  return Math.max(0, (seen?.length ?? 0) - 1);
}

function rerollsLeftLabel(rerolls: number): string {
  const left = MAX_REROLLS - rerolls;
  return `${left} re-roll${left === 1 ? '' : 's'} left`;
}

/**
 * The entries the generator has to avoid: everything shown since the pool was last
 * exhausted, and never fewer than the one just rejected.
 *
 * The history used to be reset to a single key once the whole pool had been seen, which
 * kept the no-repeat cycle going but threw away the count the re-roll cap now reads. The
 * history stays whole and the wrap happens here instead. With MAX_REROLLS below every pool
 * size (the smallest is 3 splits at 2v2) the wrap is never reached, but it stays correct
 * if the cap is ever raised past one.
 */
function toAvoid(seen: string[], poolSize: number): string[] {
  const shownThisCycle = seen.length % poolSize;
  return shownThisCycle === 0 ? seen.slice(-1) : seen.slice(-shownThisCycle);
}

/**
 * Replaces a resolved phase card with a single line of history.
 *
 * Resolution used to only rewrite the content and clear the buttons, which left the full
 * embed and image sitting in the channel forever showing the tally as it stood when the
 * vote closed. Three of those piled up in every match channel before the game even
 * started. Stripping the embed, image and buttons leaves the outcome and nothing else.
 */
async function collapseCard(message: Message, line: string): Promise<void> {
  await message
    .edit({
      content: line,
      embeds: [],
      components: [],
      files: [],
      attachments: [],
      // A collapsed card is history, not a summons -- any mention in it must not ping.
      allowedMentions: { parse: [] },
    })
    .catch(() => null);
}

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
      match,
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

  // The image draws the three mode cards, the threshold and the live tallies, and the
  // buttons repeat the tallies. There is nothing left for an embed to add. Players were
  // already pinged into this channel by the ready check, so no mention line either.
  const voteImg = await generateModeVoteImage(
    players,
    voteCounts,
    votesRequiredFor(players.map(p => p.discord_id)),
    matchQueue.team_size
  );
  const attachment = new AttachmentBuilder(voteImg, { name: 'voting_mode.png' });
  const buttons = getModeVoteButtons(voteCounts);

  const timeoutMs = config.voteTimeoutSeconds * 1000;
  const startedAt = Date.now();

  // handleModeVote only edits components and files, so this line survives every tally
  // update and is only replaced when the card collapses.
  const voteMsg = await matchChan.send({
    content: `Closes ${relativeTimestamp(startedAt + timeoutMs)} · no votes → Balanced`,
    components: [buttons],
    files: [attachment],
  });

  updateMatch(match.match_id, {
    message_id: voteMsg.id,
    queue_channel_id: channelId,
  });

  const timer = setTimeout(async () => {
    activeVoteTimers.delete(textChannelId);
    await finalizeVoteAndPop(client, textChannelId, guildId, voteMsg);
  }, timeoutMs);

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
  const voteImg = await generateModeVoteImage(
    players,
    voteCounts,
    votesRequiredFor(players.map(p => p.discord_id)),
    queue.team_size
  );
  const attachment = new AttachmentBuilder(voteImg, { name: 'voting_mode.png' });

  await message.edit({
    components: [getModeVoteButtons(voteCounts)],
    files: [attachment],
    attachments: [],
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

  return { success: true, message: `Voted: **${MODE_LABELS[votedMode]}**` };
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
  return onceAtATime(channelId, async () => {
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
          ? ` (coin flip — tied at ${maxVotes} vote${maxVotes === 1 ? '' : 's'})`
          : '';
      await collapseCard(voteMsg, `✅ **${MODE_LABELS[winningMode]}** won the vote${tiebreakNote}`);
    }

    if (winningMode === 'balanced' || winningMode === 'random') {
      await startTeamsVotePhase(client, channelId, guildId, queue, winningMode);
    } else if (winningMode === 'captains') {
      await startCaptainsVotePhase(client, channelId, guildId, queue, false);
    }
  });
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
  let pairKey: string;

  // The first pair goes into the history too, so it reads like the team vote's: entry one
  // is what the lobby was first shown, everything after it is a re-roll. It used to be
  // left out, which also let the second re-roll hand the original pair straight back.
  const seenPairs = queue.captain_vote_state?.seenCaptainPairs || [];

  if (isRandomize) {
    const res = randomizeCaptains(
      players,
      queue.captain_vote_state?.blueCaptain,
      queue.captain_vote_state?.orangeCaptain,
      toAvoid(seenPairs, captainPairCount(queue.team_size))
    );
    blueCaptain = res.blueCaptain;
    orangeCaptain = res.orangeCaptain;
    pairKey = res.pairKey;
  } else {
    const sorted = [...players].sort((a, b) => b.mmr - a.mmr);
    blueCaptain = sorted[0];
    orangeCaptain = sorted[1];
    pairKey = getCaptainPairKey(blueCaptain.discord_id, orangeCaptain.discord_id);
  }

  const newSeenPairs = [...seenPairs, pairKey];
  const rerolls = rerollsUsed(newSeenPairs);
  const isFinal = rerolls >= MAX_REROLLS;

  queue.state = 'CAPTAINS_VOTE';
  queue.captain_vote_state = {
    blueCaptain: blueCaptain.discord_id,
    orangeCaptain: orangeCaptain.discord_id,
    yesVotes: [],
    noVotes: [],
    seenCaptainPairs: newSeenPairs,
  };
  saveQueue(queue);

  const channel = (await client.channels.fetch(channelId)) as TextChannel;
  if (!channel) return;

  // A bot-only lobby (the /fillbots test path) resolves in a moment instead of waiting
  // out the vote; the deadline on the card follows whichever clock is actually running.
  const allBots = queue.player_ids.every(id => id.startsWith('test_bot_'));
  const timeoutMs = allBots ? 1500 : config.voteTimeoutSeconds * 1000;
  const startedAt = Date.now();

  // The embed says who the captains are and the buttons say what the choices are. The
  // content line carries what neither can: when the vote closes, that a player who never
  // clicks is counted as Proceed, and how many re-rolls are left. handleCaptainsVote
  // edits only embeds and components, so the line survives every tally update.
  //
  // A final pair is not a vote: there is nothing left to re-roll to, so the card says so
  // and offers no buttons.
  const content = isFinal
    ? '🔒 Final pair — re-rolls used up'
    : `Closes ${relativeTimestamp(startedAt + timeoutMs)} · no vote counts as Proceed · ${rerollsLeftLabel(rerolls)}`;
  const embed = buildCaptainsVoteEmbed(blueCaptain, orangeCaptain);
  const components = isFinal ? [] : [getCaptainsVoteButtons({ yes: 0, no: 0 })];
  // attachments: [] drops anything a re-rolled card was carrying.
  const payload = { content, embeds: [embed], components, attachments: [] };
  const fresh = { content, embeds: [embed], components };

  let sentMsg: Message;
  if (messageToEdit) {
    sentMsg = await messageToEdit.edit(payload).catch(async () => await channel.send(fresh));
  } else {
    sentMsg = await channel.send(fresh);
  }

  queue.captain_vote_state.message_id = sentMsg.id;
  saveQueue(queue);

  if (activeVoteTimers.has(channelId)) {
    clearTimeout(activeVoteTimers.get(channelId)!);
    activeVoteTimers.delete(channelId);
  }

  if (isFinal) {
    await lockCaptains(client, channelId, queue, sentMsg);
    return;
  }

  const timer = setTimeout(async () => {
    activeVoteTimers.delete(channelId);
    await finalizeCaptainsVote(client, channelId, guildId, sentMsg, allBots);
  }, timeoutMs);

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
    // A final pair has no vote to cast. Its buttons are gone, but a click on the previous
    // card can still land in the moment before it is locked -- and the edit below would
    // put the buttons back.
    if (rerollsUsed(q.captain_vote_state.seenCaptainPairs) >= MAX_REROLLS) {
      rejection = 'Captains are locked — re-rolls used up.';
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

  const embed = buildCaptainsVoteEmbed(blueCaptain, orangeCaptain);
  const buttons = getCaptainsVoteButtons({ yes: yesCount, no: noCount });

  await message.edit({
    embeds: [embed],
    components: [buttons],
  });

  const captainVotesRequired = votesRequiredFor(queue.player_ids);
  if (yesCount >= captainVotesRequired || noCount >= captainVotesRequired) {
    const timer = activeVoteTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      activeVoteTimers.delete(channelId);
    }
    await finalizeCaptainsVote(client, channelId, guildId, message);
  }

  return {
    success: true,
    message: vote === 'yes' ? 'Voted to proceed.' : 'Voted to randomize captains.',
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
  forceApprove?: boolean
): Promise<void> {
  return onceAtATime(channelId, async () => {
    const queue = getQueue(channelId);
    if (!queue || queue.state !== 'CAPTAINS_VOTE' || !queue.captain_vote_state) return;

    const yesCount = queue.captain_vote_state.yesVotes.length;
    const noCount = queue.captain_vote_state.noVotes.length;

    if (!forceApprove && noCount > yesCount) {
      logger.info(`Channel ${channelId} captains vote rejected. Randomizing new captains...`);
      // No interim edit -- startCaptainsVotePhase reuses this same message for the next
      // pair, so announcing the rejection here would only be overwritten a tick later.
      await startCaptainsVotePhase(client, channelId, guildId, queue, true, message);
    } else {
      logger.info(`Channel ${channelId} captains vote approved.`);
      await lockCaptains(client, channelId, queue, message);
    }
  });
}

/**
 * Locks the pair on the card and opens the draft. Split from the finalizer because a
 * final pair (re-rolls used up) is locked straight from startCaptainsVotePhase, with no
 * vote in between.
 */
async function lockCaptains(
  client: Client,
  channelId: string,
  queue: ActiveQueue,
  message?: Message
): Promise<void> {
  const state = queue.captain_vote_state!;
  const blueCapId = state.blueCaptain;
  const orangeCapId = state.orangeCaptain;

  if (message) {
    const how = rerollsUsed(state.seenCaptainPairs) >= MAX_REROLLS ? '🔒 Captains locked (re-rolls used up)' : '✅ Captains locked';
    await collapseCard(message, `${how}: 🔵 <@${blueCapId}> · 🟠 <@${orangeCapId}>`);
  }

  const players = getPlayersByIds(queue.guild_id, queue.team_size, queue.player_ids);

  queue.state = 'DRAFTING';
  queue.draft_state = initializeCaptainsDraftWithCaptains(players, blueCapId, orangeCapId);
  queue.captain_vote_state = undefined;
  saveQueue(queue);

  await sendCaptainsDraftCard(client, channelId, queue);
}

/**
 * Starts or restarts the Team Verification vote phase for Random / Balanced Teams.
 * Voting "No" on a split calls this again with the card to overwrite; the generators walk
 * the no-repeat pool until the re-roll cap makes a split final.
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
  const avoid = toAvoid(seenMatchups, matchupCount(queue.team_size));

  const { blueTeam, orangeTeam, matchupKey } =
    mode === 'balanced' ? createBalancedTeams(players, avoid) : createRandomTeams(players, avoid);

  const newSeen = [...seenMatchups, matchupKey!];
  const rerolls = rerollsUsed(newSeen);
  const isFinal = rerolls >= MAX_REROLLS;

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

  // Same shape as the captain vote: a bot-only lobby runs on the short clock, and the
  // deadline on the card is whichever clock is really armed.
  const allBots = queue.player_ids.every(id => id.startsWith('test_bot_'));
  const timeoutMs = allBots ? 1500 : config.voteTimeoutSeconds * 1000;
  const startedAt = Date.now();

  const content = isFinal
    ? '🔒 Final split — re-rolls used up'
    : `Closes ${relativeTimestamp(startedAt + timeoutMs)} · no vote counts as Proceed · ${rerollsLeftLabel(rerolls)}`;
  const embed = buildTeamsVoteEmbed(
    blueTeam,
    orangeTeam,
    newSeen.length,
    mode,
    matchupCount(queue.team_size)
  );
  const components = isFinal ? [] : [getTeamsVoteButtons({ yes: 0, no: 0 }, mode)];
  const payload = { content, embeds: [embed], components, attachments: [] };
  const fresh = { content, embeds: [embed], components };

  let sentMsg: Message;
  if (messageToEdit) {
    sentMsg = await messageToEdit.edit(payload).catch(async () => await channel.send(fresh));
  } else {
    sentMsg = await channel.send(fresh);
  }

  queue.team_vote_state.message_id = sentMsg.id;
  saveQueue(queue);

  if (activeVoteTimers.has(channelId)) {
    clearTimeout(activeVoteTimers.get(channelId)!);
    activeVoteTimers.delete(channelId);
  }

  if (isFinal) {
    await lockTeams(client, channelId, guildId, queue, sentMsg);
    return;
  }

  const timer = setTimeout(async () => {
    activeVoteTimers.delete(channelId);
    await finalizeTeamsVote(client, channelId, guildId, sentMsg, allBots);
  }, timeoutMs);

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
    // Same as the captain vote: a final split has no vote, and a late click must not put
    // the buttons back on it.
    if (rerollsUsed(q.team_vote_state.seenMatchups) >= MAX_REROLLS) {
      rejection = 'Teams are locked — re-rolls used up.';
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
  const embed = buildTeamsVoteEmbed(
    blueTeam,
    orangeTeam,
    seenCount,
    mode,
    matchupCount(queue.team_size)
  );
  const buttons = getTeamsVoteButtons({ yes: yesCount, no: noCount }, mode);

  await message.edit({
    embeds: [embed],
    components: [buttons],
  });

  const teamVotesRequired = votesRequiredFor(queue.player_ids);
  if (yesCount >= teamVotesRequired || noCount >= teamVotesRequired) {
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
        ? 'Voted to proceed.'
        : `Voted to re-roll (${mode === 'balanced' ? 'next-closest split' : 'new matchup'}).`,
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
  forceApprove?: boolean
): Promise<void> {
  return onceAtATime(channelId, async () => {
    const queue = getQueue(channelId);
    if (!queue || queue.state !== 'TEAMS_VOTE' || !queue.team_vote_state) return;

    const yesCount = queue.team_vote_state.yesVotes.length;
    const noCount = queue.team_vote_state.noVotes.length;

    if (!forceApprove && noCount > yesCount) {
      // Re-roll in the mode the queue actually voted for. This used to hardcode a random
      // re-roll, so voting Balanced and then rejecting the split silently handed back
      // random teams. Rows written before mode was persisted default to random.
      const mode = queue.team_vote_state.mode || 'random';
      logger.info(
        `Channel ${channelId} team verification vote rejected. Generating next ${mode} matchup without repeat...`
      );
      // The re-rolled split replaces this same message, so there is nothing to announce.
      await startTeamsVotePhase(client, channelId, guildId, queue, mode, message);
    } else {
      logger.info(`Channel ${channelId} team verification vote approved. Starting match (teams locked in)...`);
      await lockTeams(client, channelId, guildId, queue, message);
    }
  });
}

/**
 * Locks the split on the card and starts the match. Split from the finalizer for the same
 * reason as lockCaptains: a final split is locked straight from startTeamsVotePhase.
 */
async function lockTeams(
  client: Client,
  channelId: string,
  guildId: string,
  queue: ActiveQueue,
  message?: Message
): Promise<void> {
  const state = queue.team_vote_state!;
  const blueTeam = getPlayersByIds(queue.guild_id, queue.team_size, state.blueTeam);
  const orangeTeam = getPlayersByIds(queue.guild_id, queue.team_size, state.orangeTeam);

  if (message) {
    const line = rerollsUsed(state.seenMatchups) >= MAX_REROLLS ? '🔒 Teams locked in — re-rolls used up' : '✅ Teams locked in';
    await collapseCard(message, line);
  }

  await startNewMatch(client, guildId, channelId, blueTeam, orangeTeam);
  resetQueueAfterPop(client, channelId);
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

  const selectMenu = getCaptainsDraftSelectMenu(
    remaining,
    draft.pickNumber,
    draft.turn,
    picks
  );

  const currentCaptain = draft.turn === 'BLUE' ? draft.blueCaptain : draft.orangeCaptain;
  const captainIsBot = currentCaptain.startsWith('test_bot_');
  const pickTimeoutMs = (config.draftPickTimeoutSeconds || 90) * 1000;
  const sentAt = Date.now();

  // The image draws both rosters and the remaining pool, and the dropdown's placeholder
  // repeats the pick number -- so the line says whose turn it is and how long they have.
  // The auto-pick clock used to be invisible: a captain reading the card had no way to know
  // the bot would pick for them. A bot captain picks itself in a moment, so no clock there.
  // This mention is the one ping that stays: it is aimed at a single person who has to act.
  const autoPickAt = captainIsBot ? '' : ` · auto-pick ${relativeTimestamp(sentAt + pickTimeoutMs)}`;
  const sentMsg = await channel.send({
    content:
      `${draft.turn === 'BLUE' ? '🔵' : '🟠'} <@${currentCaptain}> — pick ${draft.pickNumber} of ${picks}${autoPickAt}\n` +
      `-# Order ${describePickOrder(teamSize)}`,
    components: [selectMenu],
    files: [attachment],
  });

  if (captainIsBot && remaining.length > 0) {
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
        .reply({ content: `⏰ <@${currentCaptain}> timed out — auto-picked **${autoPick.username}**` })
        .catch(() => null);

      await handleCaptainPick(client, channelId, currentCaptain, autoPick.discord_id, sentMsg).catch(
        err => logger.error('Draft auto-pick failed:', err)
      );
    }, pickTimeoutMs);

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

    await collapseCard(message, '✅ Draft complete');

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
