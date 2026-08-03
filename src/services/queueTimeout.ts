import { Client, TextChannel } from 'discord.js';
import {
  getQueue,
  saveQueue,
  getAllQueues,
  getMatchByTextChannel,
  ActiveQueue,
} from '../database/queries';
import config from '../config';
import { logger } from '../utils/logger';
import { refreshQueuePanel } from './queuePanel';

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
              content: `⏳ ${mentions} automatically removed from the queue after **${config.queueTimeoutMinutes || 30} minutes** of inactivity (${queue.player_ids.length}/6).`,
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
 * Scans all active queues on bot startup to recover from crashes or reboots during temporary states.
 * - Any rank queue stuck in a non-WAITING state without an active match is reset to WAITING.
 */
export async function recoverStuckQueues(client: Client): Promise<void> {
  const allQueues = getAllQueues();
  let recoveredCount = 0;

  for (const queue of allQueues) {
    if (queue.state !== 'WAITING') {
      const activeMatch = getMatchByTextChannel(queue.channel_id);
      if (!activeMatch || activeMatch.state === 'COMPLETED' || activeMatch.state === 'CANCELLED') {
        queue.player_ids = [];
        queue.player_join_times = {};
        queue.state = 'WAITING';
        queue.vote_counts = {};
        queue.draft_state = undefined;
        queue.ready_check_vc_id = undefined;
        saveQueue(queue);
        recoveredCount++;
        await refreshQueuePanel(client, queue.channel_id).catch(() => null);
      }
    }
  }

  if (recoveredCount > 0) {
    logger.info(`Recovered ${recoveredCount} stuck queue(s) on startup.`);
  }
}
