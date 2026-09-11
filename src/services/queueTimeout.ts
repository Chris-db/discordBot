import { Client, TextChannel } from 'discord.js';
import {
  getQueue,
  saveQueue,
  getAllQueues,
  getQueueChannels,
  deleteQueue,
  getAllLiveMatches,
  getMatchByTextChannel,
  getRecentlyFinishedMatchesWithChannels,
  ActiveQueue,
  Match,
} from '../database/queries';
import config from '../config';
import { logger } from '../utils/logger';
import { parseDbTimestamp } from '../utils/time';
import { refreshQueuePanel } from './queuePanel';
import { cancelMatch } from './matchService';
import { withGuildTheme } from './themeService';
import { deleteMatchChannels, hasPendingChannelDeletion } from './channelService';

/**
 * Checks all active waiting queues for players who have been queued for over 30 minutes
 * without a match popping, and automatically removes them.
 */
export async function checkQueueTimeouts(client: Client): Promise<void> {
  const queues = getAllQueues();
  const now = Date.now();
  const timeoutMs = (config.queueTimeoutMinutes || 30) * 60 * 1000;

  for (const queue of queues) {
    if (queue.state !== 'WAITING' || queue.player_ids.length === 0) continue;

    let modified = false;
    const removedPlayers: string[] = [];
    queue.player_join_times = queue.player_join_times || {};

    const survivingPlayerIds: string[] = [];
    for (const id of queue.player_ids) {
      const joinTime = queue.player_join_times[id];
      if (!joinTime) {
        // If join time wasn't recorded previously, initialize it to now
        queue.player_join_times[id] = now;
        survivingPlayerIds.push(id);
        modified = true;
      } else if (now - joinTime >= timeoutMs) {
        removedPlayers.push(id);
        delete queue.player_join_times[id];
        modified = true;
      } else {
        survivingPlayerIds.push(id);
      }
    }

    if (modified) {
      queue.player_ids = survivingPlayerIds;
      saveQueue(queue);

      if (removedPlayers.length > 0) {
        await withGuildTheme(queue.guild_id, () => refreshQueuePanel(client, queue.channel_id));
        try {
          const channel = (await client.channels.fetch(queue.channel_id).catch(() => null)) as TextChannel | null;
          if (channel) {
            const mentions = removedPlayers.map(id => `<@${id}>`).join(', ');
            const notice = await channel.send({
              content: `⏳ ${mentions} removed after ${config.queueTimeoutMinutes || 30}m idle · ${queue.player_ids.length}/${queue.team_size * 2}`,
            });
            setTimeout(() => notice.delete().catch(() => null), 15_000);
          }
        } catch (error) {
          logger.warn(`Could not send queue timeout notice in channel ${queue.channel_id}:`, error);
        }
      }
    }
  }
}

/** How far back the orphan sweep looks. Every candidate costs a channel lookup. */
const ORPHAN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * How long after a match finishes its channels may legitimately still be open in a
 * running process: the 90-second rematch window, or a gamble proposed at the end of it
 * (60s window, the spin, then a minute to read the result). Ten minutes is well clear.
 */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * Cancels matches that have been left hanging.
 *
 * Every phase timer (mode vote, captain vote, ready check, draft) lives in an in-memory
 * Map, so a restart or an unhandled error leaves a match live with nothing left to
 * advance it. Because a player with a live match is blocked from queueing
 * (see handleJoinQueue), a stranded match locks all 6 of them out indefinitely.
 * This is the database-backed backstop for that.
 */
export async function sweepStaleMatches(client: Client): Promise<void> {
  const now = Date.now();
  const matchTimeoutMs = (config.matchTimeoutHours || 3) * 60 * 60 * 1000;
  const setupTimeoutMs = (config.setupTimeoutMinutes || 15) * 60 * 1000;

  for (const match of getAllLiveMatches()) {
    // started_at is only set once a match reaches IN_PROGRESS; fall back to creation time.
    //
    // Must go through parseDbTimestamp: created_at is SQLite's CURRENT_TIMESTAMP, which
    // has no timezone marker, and `new Date()` reads it as local. On UTC+2 that made every
    // match look two hours old the moment it was created, so the 15-minute setup timeout
    // fired immediately and cancelled matches mid-vote.
    const referenceTime = match.state === 'IN_PROGRESS'
      ? parseDbTimestamp(match.started_at || match.created_at)
      : parseDbTimestamp(match.created_at);

    if (Number.isNaN(referenceTime)) continue;

    const age = now - referenceTime;
    const limit = match.state === 'IN_PROGRESS' ? matchTimeoutMs : setupTimeoutMs;
    if (age < limit) continue;

    const ageMins = Math.round(age / 60_000);
    logger.warn(
      `match id ${match.match_id} has been stuck in ${match.state} for ${ageMins} minutes. Auto-cancelling.`
    );

    try {
      await withGuildTheme(match.guild_id, () => cancelMatch(client, match.match_id, 'Automatic timeout'));
    } catch (err) {
      logger.error(`Failed to auto-cancel stale match id ${match.match_id}:`, err);
    }
  }

  // Cheap with the 24-hour bound, and it catches a teardown lost to anything other than a
  // restart -- an unhandled error in the timer, say -- within five minutes.
  await sweepOrphanedMatchChannels(client, ORPHAN_GRACE_MS);
}

/**
 * Deletes the channels of finished matches whose teardown never happened.
 *
 * The post-match teardown is an in-memory setTimeout, so a restart inside the 90-second
 * rematch window (or a gamble window) simply loses it. recoverStuckQueues cannot see
 * these: the temporary queue row is already gone by then. sweepStaleMatches cannot
 * either: it only looks at live matches, and these are finished. So the match text
 * channel and both team VCs sat in the server for good, one set per restart.
 *
 * `minAgeMs` is the grace for a running process, where a channel from a match that
 * finished a minute ago is in its rematch window, not orphaned. On startup it is zero:
 * no timer survived, so anything still standing is an orphan. A match with a teardown
 * pending in this process is skipped either way, as is one whose channel now hosts a
 * live rematch -- that match's own teardown will take the channel down.
 */
export async function sweepOrphanedMatchChannels(client: Client, minAgeMs = 0): Promise<void> {
  const now = Date.now();
  let removed = 0;

  for (const match of getRecentlyFinishedMatchesWithChannels(ORPHAN_LOOKBACK_MS)) {
    const finishedAt = parseDbTimestamp(match.completed_at);
    if (Number.isNaN(finishedAt) || now - finishedAt < minAgeMs) continue;
    if (hasPendingChannelDeletion(match.match_id)) continue;

    if (match.text_channel_id) {
      const occupant = getMatchByTextChannel(match.text_channel_id);
      if (occupant && occupant.match_id !== match.match_id) continue;
    }

    const ids = [
      match.text_channel_id,
      match.blue_voice_id,
      match.orange_voice_id,
      match.ready_check_vc_id,
    ].filter((id): id is string => Boolean(id));

    // Almost every candidate had a normal teardown, so this is the check that keeps the
    // sweep quiet: only a channel that still exists is worth a delete call.
    const standing: string[] = [];
    for (const id of ids) {
      if (await client.channels.fetch(id).catch(() => null)) standing.push(id);
    }
    if (standing.length === 0) continue;

    logger.warn(
      `match id ${match.match_id} finished ${Math.round((now - finishedAt) / 60_000)}m ago but still owns channel(s) ${standing.join(', ')}. Removing.`
    );
    await deleteMatchChannels(client, match.match_id);
    removed++;
  }

  if (removed > 0) {
    logger.info(`Removed the channels of ${removed} orphaned finished match(es).`);
  }
}

/**
 * Scans all active queues on bot startup to recover from crashes or reboots during temporary states.
 *
 * A queue in a transient state (READY_CHECK / VOTING / DRAFTING / ...) depends on an
 * in-memory timer that did not survive the restart. Previously this only reset queues whose
 * match was already dead, so a queue mid-vote was left in that state forever with nothing
 * to finalise it. Now the match is cancelled too, which releases the players.
 */
export async function recoverStuckQueues(client: Client): Promise<void> {
  const allQueues = getAllQueues();
  let recoveredCount = 0;

  for (const queue of allQueues) {
    if (queue.state === 'WAITING') continue;

    const activeMatch = getMatchByTextChannel(queue.channel_id);
    const matchIsLive =
      activeMatch && activeMatch.state !== 'COMPLETED' && activeMatch.state !== 'CANCELLED';

    if (matchIsLive) {
      // Its timer died with the previous process — nothing will ever advance it.
      logger.warn(
        `match id ${activeMatch!.match_id} was mid-${activeMatch!.state} at shutdown. Cancelling so its players are released.`
      );
      const cancelled = await withGuildTheme(queue.guild_id, () => cancelMatch(client, activeMatch!.match_id, 'Bot restarted')).catch(err => {
        logger.error(`Failed to cancel orphaned match id ${activeMatch!.match_id}:`, err);
        return undefined;
      });
      if (cancelled?.success) {
        await announceRestartCancellation(client, activeMatch!);
      }
      recoveredCount++;
      continue;
    }

    queue.player_ids = [];
    queue.player_join_times = {};
    queue.state = 'WAITING';
    queue.vote_counts = {};
    queue.draft_state = undefined;
    queue.captain_vote_state = undefined;
    queue.team_vote_state = undefined;
    queue.ready_check_vc_id = undefined;
    saveQueue(queue);
    recoveredCount++;
    await withGuildTheme(queue.guild_id, () => refreshQueuePanel(client, queue.channel_id)).catch(() => null);
  }

  if (recoveredCount > 0) {
    logger.info(`Recovered ${recoveredCount} stuck queue(s) on startup.`);
  }
}

/**
 * Tells the players a restart cost them their match.
 *
 * cancelMatch releases them, but the queue they came from was emptied when the match
 * popped, so from their side the match just vanished and the panel shows 0/6. One notice
 * in the rank queue channel, cleared after a minute. They are deliberately not put back
 * in the queue: a queue refilled to capacity with nobody there to click never pops,
 * which is worse than an empty one.
 */
async function announceRestartCancellation(client: Client, match: Match): Promise<void> {
  const channelId = match.queue_channel_id || match.channel_id;
  const channel = (await client.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
  if (!channel) return;

  const humans = [...match.blue_team, ...match.orange_team].filter(id => !id.startsWith('test_bot_'));
  const mentions = humans.map(id => `<@${id}>`).join(' ');
  const notice = await channel
    .send({
      content: `${mentions ? `${mentions} ` : ''}Match #${match.match_number} was cancelled by a bot restart — re-queue to play.`,
    })
    .catch(() => null);
  if (notice) {
    setTimeout(() => notice.delete().catch(() => null), 60_000);
  }
}

/**
 * Removes queue panels from channels that are not registered queue channels.
 *
 * An admin command run in the wrong channel used to create a queue row there, and from
 * then on every chat message in that channel re-posted a queue panel into it. The row
 * outlives the fix, so it is cleaned up here. Only an empty, idle row goes: a queue with
 * people in it is left alone whatever its registration says. A guild with no registered
 * channel at all is skipped -- that is a server that has not set up yet, and its one
 * panel is the real one.
 *
 * Returns the channel ids it cleaned, for the log and the tests.
 */
export async function sweepStrayQueuePanels(client: Client): Promise<string[]> {
  const cleaned: string[] = [];
  const registeredByGuild = new Map<string, Set<string>>();

  for (const queue of getAllQueues()) {
    if (!registeredByGuild.has(queue.guild_id)) {
      registeredByGuild.set(
        queue.guild_id,
        new Set(getQueueChannels(queue.guild_id).map(d => d.queue_channel_id!))
      );
    }
    const registered = registeredByGuild.get(queue.guild_id)!;
    if (registered.size === 0 || registered.has(queue.channel_id)) continue;
    if (queue.state !== 'WAITING' || queue.player_ids.length > 0) continue;

    if (queue.message_id) {
      const channel = (await client.channels.fetch(queue.channel_id).catch(() => null)) as TextChannel | null;
      if (channel) {
        await channel.messages.delete(queue.message_id).catch(() => null);
      }
    }
    deleteQueue(queue.channel_id);
    cleaned.push(queue.channel_id);
    logger.warn(`Removed a stray queue panel from unregistered channel ${queue.channel_id}.`);
  }

  return cleaned;
}
