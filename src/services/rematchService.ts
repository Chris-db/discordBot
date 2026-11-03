import { Client, TextChannel, AttachmentBuilder, Message } from 'discord.js';
import {
  getMatch,
  updateMatch,
  createMatch,
  getPlayersByIds,
  mutateMatchReportStatus,
  getSeriesScore,
  getOrInitQueueRow,
  getQueue,
  getActiveMatchForPlayer,
  Match,
} from '../database/queries';
import { cancelMatchChannelDeletion, broadcastMatchToFeed } from './channelService';
import { voidPendingGamble } from './gambleService';
import { buildActiveMatchEmbed } from '../ui/embeds';
import {
  getMatchActionButtons,
  getPostMatchButtons,
  getGambleProposeButton,
} from '../ui/buttons';
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

  // Anyone who used the 90-second window to click Join Queue in the rank channel would
  // otherwise be in this rematch and in a queue that later pops them into a third match.
  const { removePlayerFromWaitingQueues } = await import('./queuePanel');
  for (const id of [...previous.blue_team, ...previous.orange_team]) {
    await removePlayerFromWaitingQueues(client, previous.guild_id, id).catch(() => []);
  }

  const seriesId = previous.series_id || `series-${previousMatchId}-${Date.now()}`;
  const seriesGame = (previous.series_game || 1) + 1;

  if (!previous.series_id) {
    updateMatch(previousMatchId, { series_id: seriesId, series_game: 1 });
  }

  const { rlName, rlPass } = generateRlCredentials();
  const next = createMatch({
    guild_id: previous.guild_id,
    channel_id: previous.channel_id,
    team_size: previous.team_size,
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

  // A gamble still collecting agreements would otherwise spin mid-rematch and
  // rewrite a result the lobby has already moved past. Voided after the new row exists,
  // so the gamble's own teardown logic can see the channel is occupied and leave it be.
  await voidPendingGamble(client, previousMatchId);

  if (resultMessage) {
    await resultMessage
      .edit({ components: [getPostMatchButtons(previousMatchId, 0, 1, true)] })
      .catch(() => null);
  }

  const targetChannelId = previous.text_channel_id || previous.channel_id;
  const channel = (await client.channels.fetch(targetChannelId).catch(() => null)) as TextChannel;
  if (!channel) {
    logger.warn(`Rematch match id ${next.match_id}: channel ${targetChannelId} is gone.`);
    return next;
  }

  // The rematch reuses game 1's channels, so their names still carry game 1's number
  // while every card says the new one. Renamed in the background: Discord allows two
  // renames per channel per ten minutes, and a series that gets to game 4 inside that
  // window must not have its rematch stall behind the rate limit.
  renameMatchChannels(client, channel, next);

  const blueTeam = getPlayersByIds(next.guild_id, next.team_size, next.blue_team);
  const orangeTeam = getPlayersByIds(next.guild_id, next.team_size, next.orange_team);

  const vsBuffer = await generateMatchVsImage(client, next.match_number, blueTeam, orangeTeam);
  const attachment = new AttachmentBuilder(vsBuffer, { name: 'match_vs.png' });

  const embed = buildActiveMatchEmbed(
    next.match_number,
    blueTeam,
    orangeTeam,
    rlName,
    rlPass,
    next.blue_voice_id,
    next.orange_voice_id,
    next.report_status,
    votesRequiredFor([...next.blue_team, ...next.orange_team])
  );
  embed.setImage('attachment://match_vs.png');

  // The embed below carries the new lobby credentials, so this line is just the series
  // header. Everyone is already in this channel -- no re-ping.
  const seriesLine = summariseSeries(seriesId);
  const msg = await channel.send({
    content: `🔄 **Game ${seriesGame}**${seriesLine ? ` — ${seriesLine}` : ''}`,
    embeds: [embed],
    components: [getMatchActionButtons(next.match_id)],
    files: [attachment],
  });

  updateMatch(next.match_id, { message_id: msg.id });
  await broadcastMatchToFeed(client, next.match_id);

  logger.info(
    `Rematch: match id ${next.match_id} is game ${seriesGame} of series ${seriesId} (from match id ${previousMatchId}).`
  );
  return next;
}

/**
 * Points the reused text channel and team VCs at the new match number. Fire-and-forget:
 * a failed or rate-limited rename leaves a stale name, which is cosmetic; awaiting it
 * could hold up the rematch for minutes.
 */
function renameMatchChannels(client: Client, textChannel: TextChannel, match: Match): void {
  const n = match.match_number;
  // Started inside a promise so that a synchronous throw (a partial channel object with
  // no edit(), as in tests) is a caught rejection rather than a crash in startRematch.
  Promise.resolve()
    .then(() => textChannel.edit({ name: `match-${n}`, topic: `Rocket League 6mans | Match #${n} | Private Lobby` }))
    .catch(err => logger.warn(`Could not rename ${textChannel.name} for match id ${match.match_id}:`, err));

  const vcs: Array<[string | undefined, string]> = [
    [match.blue_voice_id, `🔵 Team Blue [Match #${n}]`],
    [match.orange_voice_id, `🟠 Team Orange [Match #${n}]`],
  ];
  for (const [id, name] of vcs) {
    if (!id) continue;
    Promise.resolve()
      .then(() => client.channels.fetch(id))
      .then(async vc => {
        if (vc?.isVoiceBased()) await vc.setName(name);
      })
      .catch(err => logger.warn(`Could not rename VC ${id} for match id ${match.match_id}:`, err));
  }
}

/** "Series so far: Blue 2 — 1 Orange" across every completed game with this series id. */
export function summariseSeries(seriesId: string): string {
  const { blueWins, orangeWins, games } = getSeriesScore(seriesId);
  if (games === 0) return '';
  return `Series 🔵 ${blueWins}–${orangeWins} 🟠`;
}

/**
 * Sends the clicking player -- and only them -- back to the queue they came from.
 *
 * The first player to leave ends the rematch for everyone: a rematch runs the same two
 * teams back, and once someone has gone those teams no longer exist. Letting both actions
 * stay live is what put one lobby into two simultaneous matches -- Back to Queue popped a
 * fresh match, and the still-enabled Rematch button then started a second one in the old
 * channel with the same six players.
 */
export async function handleRequeue(
  client: Client,
  matchId: number,
  userId: string,
  card?: Message
): Promise<{ success: boolean; message: string }> {
  const match = getMatch(matchId);
  if (!match) return { success: false, message: 'Match not found.' };
  if (match.state !== 'COMPLETED') {
    return { success: false, message: 'This match is not finished yet.' };
  }

  const roster = [...match.blue_team, ...match.orange_team];
  if (!roster.includes(userId)) {
    return { success: false, message: 'Only players from this match can requeue.' };
  }

  // Covers the reverse order too: once a rematch has launched everyone is already in a
  // live match, and joining a queue on top of that is what creates the second lobby.
  const live = getActiveMatchForPlayer(match.guild_id, userId);
  if (live) {
    return { success: false, message: `You are already in Match #${live.match_number}.` };
  }

  if (match.report_status.requeued?.includes(userId)) {
    return { success: false, message: 'You are already back in the queue.' };
  }

  const queueChannelId = match.queue_channel_id || match.channel_id;
  const added = getOrInitQueueRow(queueChannelId, match.guild_id, match.team_size, [userId]);

  if (added.length === 0) {
    return { success: false, message: 'Could not add you — the queue may be full or you may be banned.' };
  }

  const updated = mutateMatchReportStatus(matchId, status => {
    status.requeued = [...(status.requeued || []), userId];
    // The lobby is broken up from the first departure, so no rematch can follow.
    status.rematchResolved = true;
  });

  const requeuedCount = updated?.report_status.requeued?.length ?? 1;
  const everyoneLeft = requeuedCount >= roster.length;

  // A gamble needs every one of these players to agree, and one has just left. If a
  // proposal was open it had also cancelled the teardown; voiding it puts one back.
  await voidPendingGamble(client, matchId);

  // Refresh lazily: importing queuePanel at module scope would close an import cycle
  // (queuePanel -> matchService -> rematchService).
  const { refreshQueuePanel } = await import('./queuePanel');
  await refreshQueuePanel(client, queueChannelId).catch(() => null);

  // Filling the queue has to pop it. Every other path that adds a player -- the Join
  // Queue button and /queue add -- checks capacity afterwards; this one did not, so a
  // full roster clicking Back to Queue landed players in a full queue that then just sat
  // there with nothing driving it.
  const popped = await popIfFull(client, queueChannelId, match.guild_id);

  const resultCard = card || rematchMessages.get(matchId);
  if (resultCard) {
    await resultCard
      .edit({
        components: [
          // Rematch locked, Back to Queue still open for whoever is left. Double or
          // Nothing goes too -- it needs every player to agree, and one has just left.
          getPostMatchButtons(
            matchId,
            updated?.report_status.rematchVotes?.length ?? 0,
            votesRequiredFor(roster),
            true,
            everyoneLeft
          ),
          getGambleProposeButton(matchId, true),
        ],
        ...(everyoneLeft ? { content: '🚪 Everyone went back to the queue. Closing in 10s.' } : {}),
      })
      .catch(() => null);
  }

  if (everyoneLeft) {
    // Nobody is left to read the result card, so stop waiting out the rematch window.
    const { scheduleMatchChannelDeletion } = await import('./channelService');
    scheduleMatchChannelDeletion(client, matchId, 10_000);
  }

  return {
    success: true,
    message: popped
      ? `Back in <#${queueChannelId}> — queue popped.`
      : `Back in <#${queueChannelId}>. 🚪`,
  };
}

/**
 * Starts a ready check if the queue has reached capacity, and returns whether it did.
 *
 * The row is re-read rather than trusting the copy the caller added to: the panel refresh
 * above is awaited, so other players may have joined or left in between. The row itself
 * is handed on, exactly as the Join Queue button does -- getOrInitQueueRow caps it at
 * capacity, so it is never a partial lobby.
 */
async function popIfFull(
  client: Client,
  channelId: string,
  guildId: string
): Promise<boolean> {
  const queue = getQueue(channelId);
  if (!queue || queue.state !== 'WAITING') return false;
  if (queue.player_ids.length < queue.team_size * 2) return false;

  // The players are already in the queue row by this point, so a failure here must not
  // fail the requeue itself -- reporting an error to someone who was in fact requeued
  // would be the same confusing dead end as not popping at all.
  try {
    const { startReadyCheckPhase } = await import('./readyCheckService');
    await startReadyCheckPhase(client, channelId, guildId, queue);
    return true;
  } catch (error) {
    logger.error(`Requeue filled ${channelId} but the ready check failed to start:`, error);
    return false;
  }
}
