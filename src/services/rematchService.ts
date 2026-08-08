import { Client, TextChannel, AttachmentBuilder, Message } from 'discord.js';
import {
  getMatch,
  updateMatch,
  createMatch,
  getPlayersByIds,
  mutateMatchReportStatus,
  getMatchesBySeries,
  getOrInitQueueRow,
  Match,
} from '../database/queries';
import { cancelMatchChannelDeletion, broadcastMatchToFeed } from './channelService';
import { buildActiveMatchEmbed } from '../ui/embeds';
import { getMatchActionButtons, getPostMatchButtons } from '../ui/buttons';
import { generateRlCredentials } from '../utils/rlCredentials';
import { generateMatchVsImage } from './matchImage';
import { votesRequiredFor } from './gameRules';
import { logger } from '../utils/logger';

/**
 * The result card, kept so vote handlers can edit the live counter onto it.
 *
 * In-memory on purpose: it only has to survive the 90-second rematch window, and the vote
 * itself is persisted in report_status. A restart loses the counter display, and the
 * stale-match sweeper cleans up the channels.
 */
export const rematchMessages = new Map<number, Message>();

/**
 * Records a rematch vote.
 *
 * The vote lives in the match's report_status blob so it goes through
 * mutateMatchReportStatus, which does the read and the write inside one transaction --
 * six people mashing the button at once was exactly the race that lost report votes
 * before Phase 1.
 */
export async function handleRematchVote(
  client: Client,
  matchId: number,
  userId: string,
  vote: 'yes' | 'no',
  message?: Message
): Promise<{ success: boolean; message: string }> {
  const match = getMatch(matchId);
  if (!match) return { success: false, message: 'Match not found.' };
  if (match.state !== 'COMPLETED') {
    return { success: false, message: 'This match is not finished yet.' };
  }
  if (match.report_status.rematchResolved) {
    return { success: false, message: 'This rematch has already been decided.' };
  }

  const roster = [...match.blue_team, ...match.orange_team];
  if (!roster.includes(userId)) {
    return { success: false, message: 'Only players from this match can vote for a rematch.' };
  }

  const updated = mutateMatchReportStatus(matchId, status => {
    status.rematchVotes = (status.rematchVotes || []).filter(id => id !== userId);
    status.rematchDeclines = (status.rematchDeclines || []).filter(id => id !== userId);
    if (vote === 'yes') {
      status.rematchVotes.push(userId);
    } else {
      status.rematchDeclines.push(userId);
    }
  });

  if (!updated) return { success: false, message: 'Match not found.' };

  const yesVotes = updated.report_status.rematchVotes?.length || 0;
  const declines = updated.report_status.rematchDeclines?.length || 0;
  const required = votesRequiredFor(roster);

  const card = message || rematchMessages.get(matchId);
  if (card) {
    await card
      .edit({ components: [getPostMatchButtons(matchId, yesVotes, required)] })
      .catch(() => null);
  }

  if (yesVotes >= required) {
    await startRematch(client, matchId, card);
    return { success: true, message: 'Rematch starting! 🔄' };
  }

  // Once enough players have said no, the rematch cannot reach its threshold.
  if (declines > roster.length - required) {
    mutateMatchReportStatus(matchId, status => {
      status.rematchResolved = true;
    });
    if (card) {
      await card
        .edit({ components: [getPostMatchButtons(matchId, yesVotes, required, true)] })
        .catch(() => null);
    }
    return { success: true, message: 'Rematch declined. 👋' };
  }

  return {
    success: true,
    message:
      vote === 'yes'
        ? `Voted to run it back (${yesVotes}/${required}).`
        : 'Voted against a rematch.',
  };
}

/**
 * Creates the next match in a series with the same teams, reusing the open channels.
 *
 * A rematch is a new row rather than a reset of the old one: the previous game keeps its
 * result, its MMR deltas and its duration in history, and the series is reconstructed
 * from series_id. Reporting stays winner-only, so there is no per-game score to carry.
 */
export async function startRematch(
  client: Client,
  previousMatchId: number,
  resultMessage?: Message
): Promise<Match | undefined> {
  const previous = getMatch(previousMatchId);
  if (!previous || previous.report_status.rematchResolved) return undefined;

  mutateMatchReportStatus(previousMatchId, status => {
    status.rematchResolved = true;
  });

  // The channels the rematch runs in are the ones scheduled for teardown.
  cancelMatchChannelDeletion(previousMatchId);

  const seriesId = previous.series_id || `series-${previousMatchId}-${Date.now()}`;
  const seriesGame = (previous.series_game || 1) + 1;

  if (!previous.series_id) {
    updateMatch(previousMatchId, { series_id: seriesId, series_game: 1 });
  }

  const { rlName, rlPass } = generateRlCredentials();
  const next = createMatch({
    guild_id: previous.guild_id,
    channel_id: previous.channel_id,
    state: 'IN_PROGRESS',
    blue_team: previous.blue_team,
    orange_team: previous.orange_team,
    rl_name: rlName,
    rl_pass: rlPass,
    blue_voice_id: previous.blue_voice_id,
    orange_voice_id: previous.orange_voice_id,
    text_channel_id: previous.text_channel_id,
    queue_channel_id: previous.queue_channel_id,
    series_id: seriesId,
    series_game: seriesGame,
    division: previous.division,
  });

  if (resultMessage) {
    await resultMessage
      .edit({ components: [getPostMatchButtons(previousMatchId, 0, 1, true)] })
      .catch(() => null);
  }

  const targetChannelId = previous.text_channel_id || previous.channel_id;
  const channel = (await client.channels.fetch(targetChannelId).catch(() => null)) as TextChannel;
  if (!channel) {
    logger.warn(`Rematch #${next.match_id}: channel ${targetChannelId} is gone.`);
    return next;
  }

  const blueTeam = getPlayersByIds(next.guild_id, next.blue_team);
  const orangeTeam = getPlayersByIds(next.guild_id, next.orange_team);

  const vsBuffer = await generateMatchVsImage(client, next.match_id, blueTeam, orangeTeam);
  const attachment = new AttachmentBuilder(vsBuffer, { name: 'match_vs.png' });

  const embed = buildActiveMatchEmbed(
    next.match_id,
    blueTeam,
    orangeTeam,
    rlName,
    rlPass,
    next.blue_voice_id,
    next.orange_voice_id,
    next.report_status
  );
  embed.setImage('attachment://match_vs.png');

  const seriesLine = summariseSeries(seriesId);
  const mentions = [...next.blue_team, ...next.orange_team]
    .filter(id => !id.startsWith('test_bot_'))
    .map(id => `<@${id}>`)
    .join(' ');

  const msg = await channel.send({
    content:
      `🔄 **REMATCH — GAME ${seriesGame}** ${mentions}\n` +
      `New lobby: \`${rlName}\` / \`${rlPass}\`${seriesLine ? `\n${seriesLine}` : ''}`,
    embeds: [embed],
    components: [getMatchActionButtons(next.match_id)],
    files: [attachment],
  });

  updateMatch(next.match_id, { message_id: msg.id });
  await broadcastMatchToFeed(client, next.match_id);

  logger.info(
    `Rematch: Match #${next.match_id} is game ${seriesGame} of series ${seriesId} (from #${previousMatchId}).`
  );
  return next;
}

/** "Series so far: Blue 2 — 1 Orange" across every completed game with this series id. */
export function summariseSeries(seriesId: string): string {
  const games = getMatchesBySeries(seriesId).filter(m => m.state === 'COMPLETED');
  if (games.length === 0) return '';

  const blueWins = games.filter(m => m.winner === 'BLUE').length;
  const orangeWins = games.filter(m => m.winner === 'ORANGE').length;
  return `📊 **Series so far:** 🔵 ${blueWins} — ${orangeWins} 🟠`;
}

/**
 * Puts everyone from a finished match back into the queue they came from, in one click.
 */
export async function handleRequeue(
  client: Client,
  matchId: number,
  userId: string
): Promise<{ success: boolean; message: string }> {
  const match = getMatch(matchId);
  if (!match) return { success: false, message: 'Match not found.' };
  if (match.state !== 'COMPLETED') {
    return { success: false, message: 'This match is not finished yet.' };
  }

  const roster = [...match.blue_team, ...match.orange_team];
  if (!roster.includes(userId)) {
    return { success: false, message: 'Only players from this match can requeue it.' };
  }

  const queueChannelId = match.queue_channel_id || match.channel_id;
  const added = getOrInitQueueRow(queueChannelId, match.guild_id, roster);

  if (added.length === 0) {
    return { success: false, message: 'Nobody could be added — the queue may have popped already.' };
  }

  // Refresh lazily: importing queuePanel at module scope would close an import cycle
  // (queuePanel -> matchService -> rematchService).
  const { refreshQueuePanel } = await import('./queuePanel');
  await refreshQueuePanel(client, queueChannelId).catch(() => null);

  return {
    success: true,
    message: `Put ${added.length} player${added.length === 1 ? '' : 's'} back in <#${queueChannelId}>. 🚪`,
  };
}
