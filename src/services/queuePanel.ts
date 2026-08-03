import {
  Client,
  TextChannel,
  Message,
  User,
  AttachmentBuilder,
} from 'discord.js';
import {
  getQueue,
  saveQueue,
  updateQueueMessageId,
  deleteQueue,
  getOrCreatePlayer,
  getPlayersByIds,
  getActiveMatchForPlayer,
  setPlayerMmr,
  createMatch,
  updateMatch,
  getMatchByTextChannel,
  getActiveBan,
  getAllQueues,
  ActiveQueue,
} from '../database/queries';
import db from '../database/db';
import config from '../config';
import { createMatchChannels } from './channelService';
import { buildQueuePanelEmbed } from '../ui/embeds';
import { getQueuePanelButtons } from '../ui/buttons';
import {
  createBalancedTeams,
  createRandomTeams,
  initializeCaptainsDraft,
} from './draftService';
import { startNewMatch } from './matchService';
import { generateQueuePanelImage } from './queueImage';
import { logger } from '../utils/logger';
import { startReadyCheckPhase } from './readyCheckService';
import { sendCaptainsDraftCard } from './votingService';

const panelMoveTimers = new Map<string, NodeJS.Timeout>();
const activePanelRefreshes = new Map<string, Promise<void>>();

/**
 * Gets or initializes a queue for a given channel.
 */
export function getOrInitQueue(channelId: string, guildId: string): ActiveQueue {
  let queue = getQueue(channelId);
  if (!queue) {
    queue = {
      channel_id: channelId,
      guild_id: guildId,
      player_ids: [],
      player_join_times: {},
      state: 'WAITING',
      vote_counts: {},
    };
    saveQueue(queue);
  } else if (!queue.player_join_times) {
    queue.player_join_times = {};
  }
  return queue;
}

/**
 * Refreshes the persistent Queue Panel message in Discord if it exists.
 * Serializes refreshes per-channel to prevent concurrent updates, edits the existing
 * panel in-place if it is still the latest message in the channel, and safely updates
 * only the message ID in the database without overwriting concurrent player joins.
 */
export async function refreshQueuePanel(client: Client, channelId: string): Promise<void> {
  if (panelMoveTimers.has(channelId)) {
    clearTimeout(panelMoveTimers.get(channelId)!);
    panelMoveTimers.delete(channelId);
  }

  const previousRefresh = activePanelRefreshes.get(channelId) || Promise.resolve();
  const currentRefresh = previousRefresh.then(() => performQueuePanelRefresh(client, channelId));
  activePanelRefreshes.set(channelId, currentRefresh);
  try {
    await currentRefresh;
  } finally {
    if (activePanelRefreshes.get(channelId) === currentRefresh) {
      activePanelRefreshes.delete(channelId);
    }
  }
}

async function performQueuePanelRefresh(client: Client, channelId: string): Promise<void> {
  const queue = getQueue(channelId);
  if (!queue) return;

  try {
    const channel = (await client.channels.fetch(channelId)) as TextChannel;
    if (!channel) return;

    const players = getPlayersByIds(queue.player_ids);
    const imageBuffer = await generateQueuePanelImage(client, players);
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'queue_panel.png' });

    const embed = buildQueuePanelEmbed(players);
    embed.setImage('attachment://queue_panel.png');
    const components = [getQueuePanelButtons()];

    let editedExisting = false;
    if (queue.message_id) {
      const existingMsg = await channel.messages.fetch(queue.message_id).catch(() => null);
      if (existingMsg) {
        const recentMessages = await channel.messages.fetch({ limit: 1 }).catch(() => null);
        const isLastMessage = recentMessages && recentMessages.first()?.id === existingMsg.id;

        if (isLastMessage) {
          await existingMsg.edit({
            embeds: [embed],
            components,
            files: [attachment],
          }).catch(() => null);
          editedExisting = true;
        } else {
          await existingMsg.delete().catch(() => null);
        }
      }
    }

    if (!editedExisting) {
      const newMsg = await channel.send({
        embeds: [embed],
        components,
        files: [attachment],
      });

      updateQueueMessageId(channelId, newMsg.id);
    }
  } catch (error) {
    logger.warn(`Could not refresh queue panel in channel ${channelId}:`, error);
  }
}

/**
 * Automatically moves the Queue Panel to the bottom of the channel whenever normal chat messages are sent,
 * debounced by 1200ms to prevent rate-limit spam.
 */
export function handleChannelMessage(client: Client, message: Message): void {
  if (message.author.bot) return;

  const channelId = message.channelId;
  const queue = getQueue(channelId);
  if (!queue || !queue.message_id || queue.state !== 'WAITING') return;

  if (panelMoveTimers.has(channelId)) {
    clearTimeout(panelMoveTimers.get(channelId)!);
  }

  const timer = setTimeout(() => {
    panelMoveTimers.delete(channelId);
    refreshQueuePanel(client, channelId);
  }, 1200);

  panelMoveTimers.set(channelId, timer);
}

/**
 * Handles a player clicking "Join Queue" using an atomic SQLite transaction to prevent race conditions.
 */
export async function handleJoinQueue(
  client: Client,
  channelId: string,
  guildId: string,
  user: User
): Promise<{ success: boolean; message: string }> {
  // Check if player is banned
  const activeBan = getActiveBan(guildId, user.id);
  if (activeBan) {
    const expiryStr = activeBan.expires_at
      ? `Expires: <t:${Math.floor(new Date(activeBan.expires_at).getTime() / 1000)}:R>`
      : '**Permanent**';
    return {
      success: false,
      message: `🚫 You are banned from queuing.\n**Reason:** ${activeBan.reason}\n${expiryStr}`,
    };
  }

  // Check if player is already in an active match
  const activeMatch = getActiveMatchForPlayer(user.id);
  if (activeMatch) {
    let channelExists = false;
    if (activeMatch.text_channel_id) {
      const chan = await client.channels.fetch(activeMatch.text_channel_id).catch(() => null);
      if (chan) channelExists = true;
    }

    if (!channelExists) {
      updateMatch(activeMatch.match_id, {
        state: 'CANCELLED',
        winner: 'NONE',
        completed_at: new Date().toISOString(),
      });
    } else {
      return {
        success: false,
        message: `You are currently in active Match #${activeMatch.match_id}! Please finish or report your match first.`,
      };
    }
  }

  // Ensure player exists in DB
  getOrCreatePlayer(user.id, user.username);

  // Atomically add player to queue inside a SQLite transaction
  const txResult = db.transaction(() => {
    const queue = getOrInitQueue(channelId, guildId);
    if (queue.state !== 'WAITING') {
      return { success: false, message: 'Queue is currently popping/voting! Please wait.' };
    }
    if (queue.player_ids.includes(user.id)) {
      return { success: false, message: 'You are already in the queue!' };
    }
    queue.player_ids.push(user.id);
    queue.player_join_times = queue.player_join_times || {};
    queue.player_join_times[user.id] = Date.now();
    saveQueue(queue);
    return { success: true, message: 'Joined the queue! 🚀', newCount: queue.player_ids.length };
  })();

  if (!txResult.success) {
    return { success: false, message: txResult.message || 'Could not join queue.' };
  }

  await refreshQueuePanel(client, channelId);

  // If queue hits 6, start AFK voice ready check!
  if (txResult.newCount === 6) {
    const latestQueue = getQueue(channelId);
    if (latestQueue && latestQueue.state === 'WAITING' && latestQueue.player_ids.length === 6) {
      await startReadyCheckPhase(client, channelId, guildId, latestQueue);
    }
  }

  return { success: true, message: 'Joined the queue! 🚀' };
}

/**
 * Handles a player clicking "Leave Queue" using an atomic SQLite transaction.
 */
/**
 * Removes a player from every waiting queue in a guild and refreshes the affected panels.
 *
 * The ban check only ran at join time, so banning someone who was already sitting in a
 * queue left them there and they popped into the next match anyway. Queues past WAITING
 * are left alone -- pulling a player out mid ready-check or mid-draft would strand the
 * other five; use /match cancel for that.
 *
 * Returns the channel ids the player was removed from.
 */
export async function removePlayerFromWaitingQueues(
  client: Client,
  guildId: string,
  discordId: string
): Promise<string[]> {
  const affected = db.transaction(() => {
    const removedFrom: string[] = [];
    for (const queue of getAllQueues()) {
      if (queue.guild_id !== guildId) continue;
      if (queue.state !== 'WAITING') continue;
      if (!queue.player_ids.includes(discordId)) continue;

      queue.player_ids = queue.player_ids.filter(id => id !== discordId);
      if (queue.player_join_times) {
        delete queue.player_join_times[discordId];
      }
      saveQueue(queue);
      removedFrom.push(queue.channel_id);
    }
    return removedFrom;
  })();

  for (const channelId of affected) {
    await refreshQueuePanel(client, channelId).catch(err =>
      logger.warn(`Failed to refresh panel for ${channelId} after removing ${discordId}: ${err}`)
    );
  }

  return affected;
}

export async function handleLeaveQueue(
  client: Client,
  channelId: string,
  user: User
): Promise<{ success: boolean; message: string }> {
  const activeMatch = getActiveMatchForPlayer(user.id);
  if (activeMatch) {
    return {
      success: false,
      message: `You cannot leave the queue while you are in active Match #${activeMatch.match_id} (Ready Check/Voting/Match)!`,
    };
  }

  const txResult = db.transaction(() => {
    const queue = getQueue(channelId);
    if (!queue) {
      return { success: false, message: 'No active queue in this channel.' };
    }
    if (!queue.player_ids.includes(user.id)) {
      return { success: false, message: 'You are not in the queue.' };
    }
    if (queue.state !== 'WAITING') {
      return {
        success: false,
        message: 'The queue has already popped! You cannot leave during ready check, voting, or draft.',
      };
    }

    queue.player_ids = queue.player_ids.filter(id => id !== user.id);
    if (queue.player_join_times) {
      delete queue.player_join_times[user.id];
    }
    saveQueue(queue);
    return { success: true, message: 'Left the queue. 🚪' };
  })();

  if (!txResult.success) {
    return { success: false, message: txResult.message || 'Could not leave queue.' };
  }

  await refreshQueuePanel(client, channelId);

  return { success: true, message: 'Left the queue. 🚪' };
}

/**
 * Resets a queue back to WAITING after a match pops.
 */
export function resetQueueAfterPop(client: Client, channelId: string): void {
  const match = getMatchByTextChannel(channelId);
  if (match) {
    // This is a temporary #match-ID private text channel; clean up temporary queue record
    deleteQueue(channelId);
    return;
  }

  const queue = getQueue(channelId);
  if (!queue) return;

  queue.player_ids = [];
  queue.player_join_times = {};
  queue.state = 'WAITING';
  queue.vote_counts = {};
  queue.draft_state = undefined;
  saveQueue(queue);

  refreshQueuePanel(client, channelId);
}

/**
 * Fills remaining queue slots with simulated AI bot players for testing.
 */
export async function fillQueueWithBots(
  client: Client,
  channelId: string,
  guildId: string,
  skipVoting: boolean = false
): Promise<{ success: boolean; message: string }> {
  const queue = getOrInitQueue(channelId, guildId);
  if (queue.state !== 'WAITING') {
    return { success: false, message: 'Queue has already popped!' };
  }

  const testBots = [
    { id: 'test_bot_1', name: 'Squishy (Bot)', mmr: 1250 },
    { id: 'test_bot_2', name: 'GarrettG (Bot)', mmr: 1350 },
    { id: 'test_bot_3', name: 'Jstn (Bot)', mmr: 1100 },
    { id: 'test_bot_4', name: 'MonkeyMoon (Bot)', mmr: 1400 },
    { id: 'test_bot_5', name: 'Vatira (Bot)', mmr: 1050 },
    { id: 'test_bot_6', name: 'Scrub Killa (Bot)', mmr: 1150 },
  ];

  for (const bot of testBots) {
    if (queue.player_ids.length >= 6) break;
    if (!queue.player_ids.includes(bot.id)) {
      getOrCreatePlayer(bot.id, bot.name);
      setPlayerMmr(bot.id, bot.mmr);
      queue.player_ids.push(bot.id);
      queue.player_join_times = queue.player_join_times || {};
      queue.player_join_times[bot.id] = Date.now();
    }
  }

  saveQueue(queue);
  await refreshQueuePanel(client, channelId);

  if (queue.player_ids.length === 6 && !skipVoting) {
    await startReadyCheckPhase(client, channelId, guildId, queue);
  }

  return {
    success: true,
    message: `🤖 Filled queue with simulated bot players (${queue.player_ids.length}/6)!`,
  };
}

/**
 * Force pops the queue immediately with bots into a specified mode for testing.
 */
export async function forcePopQueue(
  client: Client,
  channelId: string,
  guildId: string,
  mode?: 'balanced' | 'captains' | 'random'
): Promise<{ success: boolean; message: string }> {
  await fillQueueWithBots(client, channelId, guildId, true);

  const queue = getQueue(channelId);
  if (!queue || queue.player_ids.length !== 6) {
    return { success: false, message: 'Could not fill queue to 6 players.' };
  }

  const players = getPlayersByIds(queue.player_ids);

  if (!mode) {
    await startReadyCheckPhase(client, channelId, guildId, queue);
    return { success: true, message: '🚀 Force-popped queue! Starting Ready Check...' };
  }

  // Create SQLite match record for force-pop mode
  const match = createMatch({
    guild_id: guildId,
    channel_id: channelId,
    state: mode === 'captains' ? 'DRAFTING' : 'IN_PROGRESS',
    blue_team: [...queue.player_ids],
    orange_team: [],
    rl_name: '',
    rl_pass: '',
  });

  // Create temporary private text & voice channels
  const { textChannelId } = await createMatchChannels(
    client,
    guildId,
    match.match_id,
    queue.player_ids,
    channelId
  );

  // Immediately reset original rank queue channel
  queue.player_ids = [];
  queue.player_join_times = {};
  queue.state = 'WAITING';
  queue.vote_counts = {};
  queue.draft_state = undefined;
  saveQueue(queue);
  await refreshQueuePanel(client, channelId);

  if (mode === 'balanced') {
    const { blueTeam, orangeTeam } = createBalancedTeams(players);
    await startNewMatch(client, guildId, textChannelId, blueTeam, orangeTeam);
    return { success: true, message: `🚀 Force-popped match in **Balanced MMR** mode! Created <#${textChannelId}>.` };
  } else if (mode === 'random') {
    const { blueTeam, orangeTeam } = createRandomTeams(players);
    await startNewMatch(client, guildId, textChannelId, blueTeam, orangeTeam);
    return { success: true, message: `🚀 Force-popped match in **Random Teams** mode! Created <#${textChannelId}>.` };
  } else if (mode === 'captains') {
    const matchQueue: ActiveQueue = {
      channel_id: textChannelId,
      guild_id: guildId,
      player_ids: [...players.map(p => p.discord_id)],
      state: 'DRAFTING',
      vote_counts: { captains: [], balanced: [], random: [] },
      draft_state: initializeCaptainsDraft(players),
    };
    saveQueue(matchQueue);

    await sendCaptainsDraftCard(client, textChannelId, matchQueue);
    return { success: true, message: `🚀 Force-popped queue into **Captains Draft**! Created <#${textChannelId}>.` };
  }

  return { success: true, message: 'Force pop complete.' };
}
