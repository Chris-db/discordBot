import { Client, TextChannel } from 'discord.js';
import {
  getQueue,
  saveQueue,
  getAllQueues,
  getAllLiveMatches,
  getMatchByTextChannel,
  ActiveQueue,
} from '../database/queries';
import config from '../config';
import { logger } from '../utils/logger';
import { parseDbTimestamp } from '../utils/time';
import { refreshQueuePanel } from './queuePanel';
import { cancelMatch } from './matchService';

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
        await refreshQueuePanel(client, queue.channel_id);
        try {
          const channel = (await client.channels.fetch(queue.channel_id).catch(() => null)) as TextChannel | null;
          if (channel) {
            const mentions = removedPlayers.map(id => `<@${id}>`).join(', ');
            const notice = await channel.send({
              content: `⏳ ${mentions} automatically removed from the queue after **${config.queueTimeoutMinutes || 30} minutes** of inactivity (${queue.player_ids.length}/${queue.team_size * 2}).`,
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
      `Match #${match.match_id} has been stuck in ${match.state} for ${ageMins} minutes. Auto-cancelling.`
    );

    try {
      await cancelMatch(client, match.match_id, 'Automatic timeout');
    } catch (err) {
      logger.error(`Failed to auto-cancel stale Match #${match.match_id}:`, err);
    }
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
        `Match #${activeMatch!.match_id} was mid-${activeMatch!.state} at shutdown. Cancelling so its players are released.`
      );
      await cancelMatch(client, activeMatch!.match_id, 'Bot restarted').catch(err =>
        logger.error(`Failed to cancel orphaned Match #${activeMatch!.match_id}:`, err)
      );
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
    await refreshQueuePanel(client, queue.channel_id).catch(() => null);
  }

  if (recoveredCount > 0) {
    logger.info(`Recovered ${recoveredCount} stuck queue(s) on startup.`);
  }
}
