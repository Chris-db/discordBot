import { Client, TextChannel, Guild, AttachmentBuilder } from 'discord.js';
import {
  createMatch,
  getMatch,
  updateMatch,
  getMatchByTextChannel,
  getPlayer,
  getPlayersByIds,
  updatePlayerAfterMatch,
  mutateMatchReportStatus,
  getQueue,
  deleteQueue,
  Player,
} from '../database/queries';
import {
  grantTeamVoiceAccessAndMove,
  scheduleMatchChannelDeletion,
  broadcastMatchToFeed,
  updateMatchFeedCard,
} from './channelService';
import {
  buildActiveMatchEmbed,
  buildMatchResultEmbed,
} from '../ui/embeds';
import { getMatchActionButtons, getGambleProposeButton, getPostMatchButtons } from '../ui/buttons';
import { generateRlCredentials } from '../utils/rlCredentials';
import {
  createMatchVoiceChannels,
  tryMovePlayersToVoice,
  deleteMatchVoiceChannels,
} from './voiceService';
import { calculateMmrDelta } from './mmrService';
import { getMatchupKey, createRandomTeams } from './draftService';
import { generateMatchVsImage } from './matchImage';
import { generateMatchResultImage } from './resultImage';
import { REMATCH_WINDOW_MS, votesRequiredFor } from './gameRules';
import { rematchMessages, summariseSeries } from './rematchService';
import { logger } from '../utils/logger';

// Vote thresholds live in gameRules.ts so rematchService can share them without the two
// modules importing each other. Re-exported for existing callers.
export { majorityOf, votesRequiredFor } from './gameRules';

/**
 * Starts a new match with temporary voice channels and RL Lobby details.
 *
 * Team size is whatever the two rosters are -- 2, 3 or 4 a side -- and it is the ladder
 * the result will count towards.
 */
export async function startNewMatch(
  client: Client,
  guildId: string,
  channelId: string,
  blueTeam: Player[],
  orangeTeam: Player[]
): Promise<void> {
  const channel = (await client.channels.fetch(channelId)) as TextChannel;
  if (!channel) return;

  const { rlName, rlPass } = generateRlCredentials();
  const existingMatch = getMatchByTextChannel(channelId);

  if (existingMatch) {
    const blueIds = blueTeam.map(p => p.discord_id);
    const orangeIds = orangeTeam.map(p => p.discord_id);

    // 1. Update Match record in SQLite
    const updated = updateMatch(existingMatch.match_id, {
      state: 'IN_PROGRESS',
      blue_team: blueIds,
      orange_team: orangeIds,
      rl_name: rlName,
      rl_pass: rlPass,
    });

    // 2. Grant team voice permissions and move players
    const { blueVoiceId, orangeVoiceId } = await grantTeamVoiceAccessAndMove(
      client,
      guildId,
      updated.match_id,
      blueIds,
      orangeIds
    );

    // Delete temporary Ready Check VC now that players are in Team Blue & Team Orange VCs
    const matchQueueData = getQueue(channelId);
    const readyVcId = updated.ready_check_vc_id || matchQueueData?.ready_check_vc_id;
    if (readyVcId) {
      const readyVc = await client.channels.fetch(readyVcId).catch(() => null);
      if (readyVc) {
        await readyVc.delete('Ready check completed, players moved to team VCs').catch(() => null);
      }
      updateMatch(updated.match_id, { ready_check_vc_id: '' });
    }

    // 3. Send private Lobby credentials card
    const vsBuffer = await generateMatchVsImage(
      client,
      updated.match_id,
      blueTeam,
      orangeTeam
    );
    const attachment = new AttachmentBuilder(vsBuffer, { name: 'match_vs.png' });

    const embed = buildActiveMatchEmbed(
      updated.match_id,
      blueTeam,
      orangeTeam,
      rlName,
      rlPass,
      blueVoiceId || updated.blue_voice_id,
      orangeVoiceId || updated.orange_voice_id,
      updated.report_status
    );
    embed.setImage('attachment://match_vs.png');

    const buttons = getMatchActionButtons(updated.match_id);

    const mentions = [...blueTeam, ...orangeTeam]
      .filter(p => !p.discord_id.startsWith('test_bot_'))
      .map(p => `<@${p.discord_id}>`)
      .join(' ');

    const matchMsg = await channel.send({
      content: `🚨 **6MANS MATCH #${updated.match_id} STARTED!** ${mentions}`,
      embeds: [embed],
      components: [buttons],
      files: [attachment],
    });

    updateMatch(updated.match_id, { message_id: matchMsg.id });

    // 4. Broadcast read-only card to public #active-matches feed
    await broadcastMatchToFeed(client, updated.match_id);

    logger.info(`Started 3-layer Match #${updated.match_id} in channel #${channel.name}`);
    return;
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);

  let blueVoiceId: string | undefined;
  let orangeVoiceId: string | undefined;

  // Create temporary voice channels
  if (guild) {
    const channels = await createMatchVoiceChannels(guild, 0, channel.parentId || undefined);
    blueVoiceId = channels.blueVoiceId;
    orangeVoiceId = channels.orangeVoiceId;
  }

  // Create Match DB record
  const match = createMatch({
    guild_id: guildId,
    channel_id: channelId,
    team_size: blueTeam.length,
    blue_team: blueTeam.map(p => p.discord_id),
    orange_team: orangeTeam.map(p => p.discord_id),
    rl_name: rlName,
    rl_pass: rlPass,
    blue_voice_id: blueVoiceId,
    orange_voice_id: orangeVoiceId,
  });

  // Rename voice channels with real match_id
  if (guild && blueVoiceId && orangeVoiceId) {
    const blueVc = await guild.channels.fetch(blueVoiceId).catch(() => null);
    const orangeVc = await guild.channels.fetch(orangeVoiceId).catch(() => null);
    await blueVc?.setName(`🔵 Team Blue [Match #${match.match_id}]`).catch(() => null);
    await orangeVc?.setName(`🟠 Team Orange [Match #${match.match_id}]`).catch(() => null);

    // Try to auto-move players who are in voice
    await tryMovePlayersToVoice(
      guild,
      match.blue_team,
      match.orange_team,
      blueVoiceId,
      orangeVoiceId
    );
  }

  const vsBuffer = await generateMatchVsImage(
    client,
    match.match_id,
    blueTeam,
    orangeTeam
  );
  const attachment = new AttachmentBuilder(vsBuffer, { name: 'match_vs.png' });

  const embed = buildActiveMatchEmbed(
    match.match_id,
    blueTeam,
    orangeTeam,
    rlName,
    rlPass,
    blueVoiceId,
    orangeVoiceId,
    match.report_status
  );
  embed.setImage('attachment://match_vs.png');

  const buttons = getMatchActionButtons(match.match_id);

  const mentions = [...blueTeam, ...orangeTeam].map(p => `<@${p.discord_id}>`).join(' ');
  const matchMsg = await channel.send({
    content: `🚨 **6MANS MATCH #${match.match_id} STARTED!** ${mentions}`,
    embeds: [embed],
    components: [buttons],
    files: [attachment],
  });

  updateMatch(match.match_id, { message_id: matchMsg.id });
  logger.info(`Started Match #${match.match_id} in channel ${channelId}`);
}

/**
 * Handles player score report clicks.
 */
export async function handleMatchReportVote(
  client: Client,
  matchId: number,
  reporterId: string,
  reportedWinner: 'BLUE' | 'ORANGE'
): Promise<{ success: boolean; message: string; completed?: boolean }> {
  const match = getMatch(matchId);
  if (!match || match.state !== 'IN_PROGRESS') {
    return { success: false, message: 'This match is no longer active.' };
  }

  const isBluePlayer = match.blue_team.includes(reporterId);
  const isOrangePlayer = match.orange_team.includes(reporterId);
  if (!isBluePlayer && !isOrangePlayer) {
    return { success: false, message: 'Only players in this match can report scores!' };
  }

  // Atomic — two players clicking in the same tick used to lose one of the votes.
  const updated = mutateMatchReportStatus(matchId, status => {
    // Remove any existing vote by this reporter
    status.blueVotes = status.blueVotes!.filter(id => id !== reporterId);
    status.orangeVotes = status.orangeVotes!.filter(id => id !== reporterId);
    status.cancelVotes = status.cancelVotes!.filter(id => id !== reporterId);

    if (reportedWinner === 'BLUE') {
      status.blueVotes.push(reporterId);
    } else {
      status.orangeVotes.push(reporterId);
    }
  });

  if (!updated) {
    return { success: false, message: 'This match is no longer active.' };
  }

  // Refresh Active Match Embed
  await updateActiveMatchEmbed(client, matchId);

  const blueVotesCount = updated.report_status.blueVotes?.length || 0;
  const orangeVotesCount = updated.report_status.orangeVotes?.length || 0;

  // A majority of this lobby, whatever size it is -- 3 of 4, 4 of 6, 5 of 8 -- and never
  // more than the number of humans who could actually click.
  const required = votesRequiredFor([...updated.blue_team, ...updated.orange_team]);

  if (blueVotesCount >= required) {
    await completeMatch(client, matchId, 'BLUE');
    return { success: true, message: 'Confirmed! Team Blue wins!', completed: true };
  } else if (orangeVotesCount >= required) {
    await completeMatch(client, matchId, 'ORANGE');
    return { success: true, message: 'Confirmed! Team Orange wins!', completed: true };
  }

  return {
    success: true,
    message: `Voted for **Team ${reportedWinner === 'BLUE' ? 'Blue 🔵' : 'Orange 🟠'} Win** (${
      reportedWinner === 'BLUE' ? blueVotesCount : orangeVotesCount
    }/${required} votes needed).`,
  };
}

/**
 * Handles player cancel match votes, needing a majority of the lobby.
 */
export async function handleMatchCancelVote(
  client: Client,
  matchId: number,
  voterId: string
): Promise<{ success: boolean; message: string; cancelled?: boolean }> {
  const match = getMatch(matchId);
  if (!match || match.state !== 'IN_PROGRESS') {
    return { success: false, message: 'This match is no longer active.' };
  }

  const isBluePlayer = match.blue_team.includes(voterId);
  const isOrangePlayer = match.orange_team.includes(voterId);
  if (!isBluePlayer && !isOrangePlayer) {
    return { success: false, message: 'Only players in this match can vote to cancel!' };
  }

  const updated = mutateMatchReportStatus(matchId, status => {
    // Remove existing vote by this player from blue/orange win votes
    status.blueVotes = status.blueVotes!.filter(id => id !== voterId);
    status.orangeVotes = status.orangeVotes!.filter(id => id !== voterId);

    if (!status.cancelVotes!.includes(voterId)) {
      status.cancelVotes!.push(voterId);
    }
  });

  if (!updated) {
    return { success: false, message: 'This match is no longer active.' };
  }

  await updateActiveMatchEmbed(client, matchId);

  const cancelVotesCount = updated.report_status.cancelVotes?.length || 0;
  const required = votesRequiredFor([...updated.blue_team, ...updated.orange_team]);
  if (cancelVotesCount >= required) {
    await cancelMatch(client, matchId, `${cancelVotesCount} Player Votes`);
    return {
      success: true,
      message: `Confirmed! ${cancelVotesCount}/${required} votes reached — Match cancelled.`,
      cancelled: true,
    };
  }

  return {
    success: true,
    message: `Voted to **Cancel Match** (${cancelVotesCount}/${required} votes needed).`,
  };
}

/**
 * Completes a match, calculates ELO, updates players, and deletes voice channels.
 */
export async function completeMatch(
  client: Client,
  matchId: number,
  winner: 'BLUE' | 'ORANGE'
): Promise<void> {
  const match = getMatch(matchId);
  if (!match || match.state !== 'IN_PROGRESS') return;

  const bluePlayers = getPlayersByIds(match.guild_id, match.team_size, match.blue_team);
  const orangePlayers = getPlayersByIds(match.guild_id, match.team_size, match.orange_team);

  const { blueDelta, orangeDelta } = calculateMmrDelta(bluePlayers, orangePlayers, winner);

  // Apply MMR, then re-read the row so the card can show the streak the win just produced.
  // The delta stays the one actually applied -- recomputing it from post-update ratings is
  // what made the public feed card disagree with reality (P1-8).
  //
  // Everything here is scoped to match.team_size: a 3v3 result must not move anyone's 2v2.
  const applyTo = (p: Player, delta: number, isWin: boolean) => {
    updatePlayerAfterMatch(match.guild_id, match.team_size, p.discord_id, delta, isWin);
    const after = getPlayer(match.guild_id, match.team_size, p.discord_id) || p;
    return { player: after, delta, newMmr: after.mmr, previousStreak: p.streak };
  };

  const blueResults = bluePlayers.map(p => applyTo(p, blueDelta, winner === 'BLUE'));
  const orangeResults = orangePlayers.map(p => applyTo(p, orangeDelta, winner === 'ORANGE'));

  const completedAt = new Date().toISOString();
  updateMatch(matchId, {
    state: 'COMPLETED',
    winner,
    gamble_status: {
      state: 'NONE',
      agreedPlayers: [],
      blueDelta,
      orangeDelta,
    },
    completed_at: completedAt,
  });

  await updateMatchFeedCard(client, matchId);

  let durationStr: string | undefined;
  if (match.started_at) {
    const secs = Math.floor((new Date(completedAt).getTime() - new Date(match.started_at).getTime()) / 1000);
    if (secs >= 0 && !isNaN(secs)) {
      const mins = Math.floor(secs / 60);
      const remSecs = secs % 60;
      durationStr = `${mins}m ${remSecs}s`;
    }
  }

  const targetChannelId = match.text_channel_id || match.channel_id;
  const channel = (await client.channels.fetch(targetChannelId).catch(() => null)) as TextChannel;
  if (channel) {
    const imageBuffer = await generateMatchResultImage(
      client,
      matchId,
      winner,
      blueResults,
      orangeResults,
      durationStr
    );
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'match_result.png' });

    const resultEmbed = buildMatchResultEmbed(matchId, winner, blueResults, orangeResults, durationStr);
    resultEmbed.setImage('attachment://match_result.png');

    const rematchRequired = votesRequiredFor([...match.blue_team, ...match.orange_team]);

    const seriesLine = match.series_id ? `\n${summariseSeries(match.series_id)}` : '';
    const resultMsg = await channel.send({
      content:
        `🏆 **MATCH #${matchId} COMPLETED!** GG!${seriesLine}\n` +
        `Run it back with **Rematch**, or head **Back to Queue** — otherwise this channel ` +
        `closes in ${Math.round(REMATCH_WINDOW_MS / 1000)} seconds.`,
      embeds: [resultEmbed],
      files: [attachment],
      components: [
        getPostMatchButtons(matchId, 0, rematchRequired),
        getGambleProposeButton(matchId, false),
      ],
    });

    // The vote handlers edit this message to keep the counter live.
    rematchMessages.set(matchId, resultMsg);

    if (match.message_id) {
      const originalMsg = await channel.messages.fetch(match.message_id).catch(() => null);
      if (originalMsg) await originalMsg.edit({ components: [] }).catch(() => null);
    }
  }

  if (match.text_channel_id) {
    // The teardown is cancellable now, so a rematch can call it off.
    scheduleMatchChannelDeletion(client, matchId, REMATCH_WINDOW_MS);
  } else {
    const guild = await client.guilds.fetch(match.guild_id).catch(() => null);
    if (guild) {
      await deleteMatchVoiceChannels(guild, match.blue_voice_id, match.orange_voice_id);
    }
  }

  logger.info(`Completed Match #${matchId}. Winner: ${winner}`);
}

/**
 * Cancels a match and deletes temporary voice channels.
 */
export async function cancelMatch(
  client: Client,
  matchId: number,
  cancelerTag?: string
): Promise<{ success: boolean; message: string }> {
  const match = getMatch(matchId);
  if (!match) {
    return { success: false, message: 'Match not found.' };
  }

  const cancelableStates = ['READY_CHECK', 'VOTING', 'DRAFTING', 'IN_PROGRESS'];
  if (!cancelableStates.includes(match.state)) {
    if (match.text_channel_id) {
      scheduleMatchChannelDeletion(client, matchId, 100);
    }
    return {
      success: false,
      message: `Match #${matchId} is already ${match.state.toLowerCase()}! Lingering channels are being deleted.`,
    };
  }

  updateMatch(matchId, {
    state: 'CANCELLED',
    winner: 'NONE',
    completed_at: new Date().toISOString(),
  });

  // Tear the Ready Check VC down straight away rather than waiting for the delayed channel
  // cleanup — an empty "Ready Check #N" room sitting in the sidebar looks like the bot broke.
  const readyVcId = match.ready_check_vc_id || (match.text_channel_id ? getQueue(match.text_channel_id)?.ready_check_vc_id : undefined);
  if (readyVcId) {
    const readyVc = await client.channels.fetch(readyVcId).catch(() => null);
    if (readyVc) {
      await readyVc.delete('Match cancelled').catch(() => null);
    }
  }

  // Only the temporary #match-ID queue row may be deleted. match.channel_id points at
  // the persistent rank queue channel, and deleting that row wipes the panel message id
  // plus everyone currently waiting in it.
  if (match.text_channel_id) {
    deleteQueue(match.text_channel_id);
  }

  // Update public feed card
  await updateMatchFeedCard(client, matchId);

  const targetChannelId = match.text_channel_id || match.channel_id;
  const channel = (await client.channels.fetch(targetChannelId).catch(() => null)) as TextChannel;
  if (channel) {
    await channel.send({
      content: `❌ **MATCH #${matchId} CANCELLED** ${
        cancelerTag ? `by ${cancelerTag}` : ''
      }. This private channel and voice rooms will auto-delete in 10 seconds.`,
    });

    if (match.message_id) {
      const originalMsg = await channel.messages.fetch(match.message_id).catch(() => null);
      if (originalMsg) {
        await originalMsg.edit({ components: [] }).catch(() => null);
      }
    }
  }

  if (match.text_channel_id) {
    scheduleMatchChannelDeletion(client, matchId, 10_000);
  } else {
    const guild = await client.guilds.fetch(match.guild_id).catch(() => null);
    if (guild) {
      await deleteMatchVoiceChannels(guild, match.blue_voice_id, match.orange_voice_id);
    }
  }

  logger.info(`Cancelled Match #${matchId}`);
  return { success: true, message: `Match #${matchId} cancelled successfully.` };
}

/**
 * Force reports a match winner (Admin / Mod Override).
 */
export async function forceReportMatch(
  client: Client,
  matchId: number,
  winner: 'BLUE' | 'ORANGE'
): Promise<{ success: boolean; message: string }> {
  const match = getMatch(matchId);
  if (!match || match.state !== 'IN_PROGRESS') {
    return { success: false, message: `Match #${matchId} is not currently active.` };
  }

  await completeMatch(client, matchId, winner);
  return { success: true, message: `Match #${matchId} force-completed. Winner: **Team ${winner}**` };
}

/**
 * Helper to update the active match embed with current vote tallies.
 */
async function updateActiveMatchEmbed(client: Client, matchId: number): Promise<void> {
  const match = getMatch(matchId);
  if (!match || !match.message_id) return;

  try {
    const targetChannelId = match.text_channel_id || match.channel_id;
    const channel = (await client.channels.fetch(targetChannelId)) as TextChannel;
    if (!channel) return;

    const msg = await channel.messages.fetch(match.message_id).catch(() => null);
    if (!msg) return;

    const blueTeam = getPlayersByIds(match.guild_id, match.team_size, match.blue_team);
    const orangeTeam = getPlayersByIds(match.guild_id, match.team_size, match.orange_team);

    const embed = buildActiveMatchEmbed(
      matchId,
      blueTeam,
      orangeTeam,
      match.rl_name,
      match.rl_pass,
      match.blue_voice_id,
      match.orange_voice_id,
      match.report_status
    );

    // The original message carries match_vs.png. Editing with an embed that doesn't
    // reference it drops the VS card from the match message on the first report vote.
    // The attachment is still on the message, so re-pointing at it is enough.
    embed.setImage('attachment://match_vs.png');

    await msg.edit({ embeds: [embed] });
  } catch (error) {
    logger.warn(`Could not update active match embed for Match #${matchId}:`, error);
  }
}
