import {
  Client,
  TextChannel,
  Message,
  User,
  AttachmentBuilder,
  PermissionFlagsBits,
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
  getDivisionByChannel,
  getDivision,
  updateDivision,
  ActiveQueue,
} from '../database/queries';
import { DEFAULT_TEAM_SIZE } from '../database/migrations';
import db from '../database/db';
import config from '../config';
import { createMatchChannels } from './channelService';
import { prefetchAvatar } from '../utils/avatarCache';
import { getQueuePanelButtons } from '../ui/buttons';
import {
  createBalancedTeams,
  createRandomTeams,
  initializeCaptainsDraft,
} from './draftService';
import { startNewMatch } from './matchService';
import { generateQueuePanelImage } from './queueImage';
import { logger } from '../utils/logger';
import { startReadyCheckPhase, AFK_COOLDOWN_REASON } from './readyCheckService';
import { sendCaptainsDraftCard } from './votingService';

const panelMoveTimers = new Map<string, NodeJS.Timeout>();
const activePanelRefreshes = new Map<string, Promise<void>>();

/**
 * When each queue channel last pinged its division. A join-leave-join inside a minute is
 * one person changing their mind, not three new lobbies, and a role ping is the loudest
 * thing the bot does.
 */
const lastQueueOpenPings = new Map<string, number>();
export const QUEUE_OPEN_PING_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * The ping still standing in each channel, so it can come down once it stops being true.
 * In memory only: a restart orphans at most one line per channel, which is not worth a
 * column.
 */
const openQueuePings = new Map<string, Message>();

/** "Someone started a queue" holds while it is waiting with at least one seat taken and one free. */
function queueStillOpen(queue: ActiveQueue): boolean {
  return (
    queue.state === 'WAITING' &&
    queue.player_ids.length > 0 &&
    queue.player_ids.length < queue.team_size * 2
  );
}

/**
 * Takes the channel's ping down if the queue has since emptied, filled, or popped.
 *
 * Called from the panel refresh, which every roster change already goes through -- a
 * leave, /queue remove or clear, the idle sweep, the sixth join, the reset after a pop --
 * so no path has to remember to do it.
 */
async function retireQueueOpenPing(queue: ActiveQueue): Promise<void> {
  const ping = openQueuePings.get(queue.channel_id);
  if (!ping || queueStillOpen(queue)) return;
  openQueuePings.delete(queue.channel_id);
  await ping.delete().catch(() => null);
}

/**
 * A join or leave, decided. `settled` is the follow-up work -- panel refresh, and on a
 * full queue the ready check -- already running; callers answer the click, then await it.
 */
export interface QueueClickResult {
  success: boolean;
  message: string;
  settled?: Promise<void>;
}

/**
 * The team size a channel queues at.
 *
 * A queue channel is registered against exactly one (division, size) pair, so the division
 * row that owns the channel is the single source of truth. A channel nobody has registered
 * -- a scratch channel someone ran `/queue panel` in -- falls back to 3v3.
 */
export function resolveTeamSize(guildId: string, channelId: string): number {
  return getDivisionByChannel(guildId, channelId)?.team_size ?? DEFAULT_TEAM_SIZE;
}

/**
 * The ladder a button pressed in this channel should read from.
 *
 * Prefers the live queue row, which is what the panel above the button is actually
 * showing, and falls back to the channel's registration for buttons pressed somewhere
 * without a queue (a /leaderboard reply in general chat, say).
 */
export function channelTeamSize(guildId: string, channelId: string): number {
  return getQueue(channelId)?.team_size ?? resolveTeamSize(guildId, channelId);
}

/**
 * Gets or initializes a queue for a given channel.
 *
 * The size is resolved once, here, and then read off the row for the rest of the queue's
 * life. Re-resolving mid-flow would let an admin repointing a channel change the size of a
 * lobby that is already mid ready-check.
 */
/**
 * Makes a channel *the* queue channel for one (division, size) ladder and posts its panel.
 *
 * This is the one place a channel gets registered, shared by `/queue panel` and `/setup`.
 * The division row is the single source of truth for a channel's size and ladder, and the
 * queue row caches the size, so an existing (empty) queue row has to be told too. Callers
 * are responsible for refusing a size change on a queue that is popped or has players.
 */
export async function registerQueueChannel(
  client: Client,
  guildId: string,
  channelId: string,
  teamSize: number,
  division: string
): Promise<ActiveQueue> {
  updateDivision(guildId, teamSize, division, { queue_channel_id: channelId });
  const existing = getQueue(channelId);
  if (existing && existing.team_size !== teamSize) {
    existing.team_size = teamSize;
    saveQueue(existing);
  }
  getOrInitQueue(channelId, guildId);
  await refreshQueuePanel(client, channelId);
  return getQueue(channelId)!;
}

export function getOrInitQueue(channelId: string, guildId: string): ActiveQueue {
  let queue = getQueue(channelId);
  if (!queue) {
    queue = {
      channel_id: channelId,
      guild_id: guildId,
      team_size: resolveTeamSize(guildId, channelId),
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

    await retireQueueOpenPing(queue);

    const players = getPlayersByIds(queue.guild_id, queue.team_size, queue.player_ids);

    // The panel image already draws the size, the count badge, every queued player with
    // their MMR, and the empty slots. An embed listing the same roster underneath it was
    // the same panel twice.
    const imageBuffer = await generateQueuePanelImage(
      client,
      players,
      queue.team_size,
      getDivisionByChannel(queue.guild_id, channelId)?.division
    );
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'queue_panel.png' });
    const components = [getQueuePanelButtons()];

    // Every call to Discord is a round trip -- from here about 200ms each -- and this
    // refresh used to make three before it had changed anything: fetch the panel, fetch
    // the newest message to see if they were the same, then edit. The gateway already
    // keeps lastMessageId current, and an edit by id needs no fetch first, so it is one
    // call now. A failed edit means the panel is gone; fall through and send a fresh one.
    let editedExisting = false;
    if (queue.message_id) {
      if (channel.lastMessageId === queue.message_id) {
        const edited = await channel.messages
          .edit(queue.message_id, { content: null, embeds: [], components, files: [attachment], attachments: [] })
          .catch(() => null);
        editedExisting = edited !== null;
      } else {
        await channel.messages.delete(queue.message_id).catch(() => null);
      }
    }

    if (!editedExisting) {
      const newMsg = await channel.send({
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

  // Only a registered queue channel gets its panel re-pinned. A queue row used to be
  // enough, and an admin command run in #general created one there -- after which every
  // chat message in #general re-posted a queue panel into it.
  if (!getDivisionByChannel(queue.guild_id, channelId)) return;

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
 * Tells a division that someone is waiting in its queue.
 *
 * One player in an otherwise empty queue is where most lobbies die -- nobody else knows
 * they are there. So the first join pings the channel's division role: Rank C on a ranked
 * server, the single ladder's role on a one-ladder server (the same row, so the same
 * lookup). A channel with no registered division or no role is left quiet.
 *
 * Only the role may mention. The player is written as `<@id>` so Discord shows their
 * server nickname, but `allowedMentions` keeps that, and anything else in the message,
 * from notifying anyone. The roles /setup creates are not mentionable by members, which
 * means the bot needs its own "Mention @everyone, @here and All Roles" permission; without
 * it Discord posts the text and notifies nobody, and the warning below is the only clue.
 *
 * Runs before the panel refresh on purpose: the refresh sees the ping is now the newest
 * message and re-posts the panel beneath it, so the panel stays at the bottom. The ping
 * comes down again once the queue empties, fills or pops (see retireQueueOpenPing).
 */
export async function announceQueueOpened(
  client: Client,
  channelId: string,
  guildId: string,
  user: User,
  count: number,
  capacity: number
): Promise<void> {
  const roleId = getDivisionByChannel(guildId, channelId)?.role_id;
  if (!roleId) return;

  const now = Date.now();
  if (now - (lastQueueOpenPings.get(channelId) ?? 0) < QUEUE_OPEN_PING_COOLDOWN_MS) return;
  lastQueueOpenPings.set(channelId, now);

  const channel = (await client.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
  if (!channel) return;

  const botPerms = client.user ? channel.permissionsFor?.(client.user) : null;
  if (botPerms && !botPerms.has(PermissionFlagsBits.MentionEveryone)) {
    logger.warn(
      `Queue ping in ${channelId}: bot lacks "Mention @everyone, @here and All Roles", so role ${roleId} will not be notified.`
    );
  }

  // A ping the last refresh failed to delete would otherwise stand twice.
  await openQueuePings.get(channelId)?.delete().catch(() => null);

  const ping = await channel.send({
    content: `<@&${roleId}> <@${user.id}> started a queue — ${count}/${capacity}`,
    allowedMentions: { roles: [roleId] },
  });
  openQueuePings.set(channelId, ping);
}

/**
 * Handles a player clicking "Join Queue" using an atomic SQLite transaction to prevent race conditions.
 */
export async function handleJoinQueue(
  client: Client,
  channelId: string,
  guildId: string,
  user: User
): Promise<QueueClickResult> {
  // Check if player is banned
  const activeBan = getActiveBan(guildId, user.id);
  if (activeBan) {
    const expiresStamp = activeBan.expires_at
      ? `<t:${Math.floor(new Date(activeBan.expires_at).getTime() / 1000)}:R>`
      : '';
    // A ready-check cooldown is a ban row underneath, but "you are banned" is the wrong
    // thing to tell someone whose game crashed five minutes ago.
    if (activeBan.reason === AFK_COOLDOWN_REASON && expiresStamp) {
      return {
        success: false,
        message: `⏳ You missed the last ready check. You can queue again ${expiresStamp}.`,
      };
    }
    const expiryStr = expiresStamp ? `Expires: ${expiresStamp}` : '**Permanent**';
    return {
      success: false,
      message: `🚫 You are banned from queuing.\n**Reason:** ${activeBan.reason}\n${expiryStr}`,
    };
  }

  // Check if player is already in an active match
  const activeMatch = getActiveMatchForPlayer(guildId, user.id);
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
        message: `You are currently in active Match #${activeMatch.match_number}! Please finish or report your match first.`,
      };
    }
  }

  // Ensure the player has a row on this channel's ladder. Their first 2v2 starts fresh
  // rather than inheriting their 3v3 rating.
  const teamSize = resolveTeamSize(guildId, channelId);
  const player = getOrCreatePlayer(guildId, teamSize, user.id, user.username);

  // A registered channel is one division's queue, and a match played in it is rated as
  // that division's game. Discord roles are meant to keep the wrong division out, but the
  // bot never checked, so a Rank C player in the Rank A channel would have been rated on
  // A games. Admins can still /queue add someone across the line on purpose.
  const channelDivision = getDivisionByChannel(guildId, channelId);
  if (channelDivision && channelDivision.division !== player.division) {
    const home = getDivision(guildId, teamSize, player.division);
    const homeHint = home?.queue_channel_id
      ? ` Your queue is <#${home.queue_channel_id}>.`
      : ` No ${home?.display_name ?? `Rank ${player.division}`} queue is set up yet.`;
    return {
      success: false,
      message: `🚫 This is the **${channelDivision.display_name}** queue and you are placed in **${home?.display_name ?? `Rank ${player.division}`}**.${homeHint}`,
    };
  }

  // Atomically add player to queue inside a SQLite transaction
  const txResult = db.transaction(() => {
    const queue = getOrInitQueue(channelId, guildId);
    if (queue.state !== 'WAITING') {
      return { success: false, message: 'Queue is currently popping/voting! Please wait.' };
    }
    if (queue.player_ids.includes(user.id)) {
      return { success: false, message: 'You are already in the queue!' };
    }
    // Decided here, inside the transaction: read after the write, two first-joiners in
    // the same instant would both look like the second.
    const wasEmpty = queue.player_ids.length === 0;
    queue.player_ids.push(user.id);
    queue.player_join_times = queue.player_join_times || {};
    queue.player_join_times[user.id] = Date.now();
    saveQueue(queue);
    return {
      success: true,
      message: 'Joined the queue! 🚀',
      newCount: queue.player_ids.length,
      capacity: queue.team_size * 2,
      wasEmpty,
    };
  })();

  if (!txResult.success) {
    return { success: false, message: txResult.message || 'Could not join queue.' };
  }

  // The click is decided the moment the row is written. Everything after this is the
  // panel re-render and, on a full queue, the whole ready-check setup -- several Discord
  // round trips the clicker does not need to wait for. It is handed back as a promise so
  // the caller can answer them first and only then wait for the rest.
  // Start the avatar download now, in the background, so the cards drawn at pop time
  // find it cached instead of each waiting on Discord's CDN.
  prefetchAvatar(client, user.id);

  const settled = (async () => {
    if (txResult.wasEmpty) {
      await announceQueueOpened(client, channelId, guildId, user, txResult.newCount!, txResult.capacity!).catch(
        err => logger.warn(`Queue-open ping failed in ${channelId}:`, err)
      );
    }

    await refreshQueuePanel(client, channelId);

    // Queue full -- start the AFK voice ready check.
    if (txResult.newCount === txResult.capacity) {
      const latestQueue = getQueue(channelId);
      if (
        latestQueue &&
        latestQueue.state === 'WAITING' &&
        latestQueue.player_ids.length === latestQueue.team_size * 2
      ) {
        await startReadyCheckPhase(client, channelId, guildId, latestQueue);
      }
    }
  })().catch(err => logger.error(`Join queue follow-up failed in ${channelId}:`, err));

  return { success: true, message: 'Joined the queue! 🚀', settled };
}

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
  discordId: string,
  exceptChannelId?: string
): Promise<string[]> {
  return removePlayersFromWaitingQueues(client, guildId, [discordId], exceptChannelId);
}

/**
 * The same for a whole lobby at once, which is what a queue pop needs.
 *
 * Sitting in the 2v2 and 3v3 queues together is allowed -- you get whichever pops first --
 * but nothing used to take you out of the other one when it did, so the second queue
 * popped later with a player who was already mid-match. Doing the six removals as one
 * pass means each other panel is redrawn once rather than six times.
 *
 * `exceptChannelId` is the queue that is popping. The pop trims its own row, and taking
 * the roster out of it here would only add a pointless refresh of that panel.
 */
export async function removePlayersFromWaitingQueues(
  client: Client,
  guildId: string,
  discordIds: string[],
  exceptChannelId?: string
): Promise<string[]> {
  const leaving = new Set(discordIds);
  const affected = db.transaction(() => {
    const removedFrom: string[] = [];
    for (const queue of getAllQueues()) {
      if (queue.guild_id !== guildId) continue;
      if (queue.channel_id === exceptChannelId) continue;
      if (queue.state !== 'WAITING') continue;
      if (!queue.player_ids.some(id => leaving.has(id))) continue;

      queue.player_ids = queue.player_ids.filter(id => !leaving.has(id));
      if (queue.player_join_times) {
        for (const id of leaving) delete queue.player_join_times[id];
      }
      saveQueue(queue);
      removedFrom.push(queue.channel_id);
    }
    return removedFrom;
  })();

  for (const channelId of affected) {
    await refreshQueuePanel(client, channelId).catch(err =>
      logger.warn(`Failed to refresh panel for ${channelId} after removing ${discordIds.join(', ')}: ${err}`)
    );
  }

  return affected;
}

/**
 * Handles a player clicking "Leave Queue" using an atomic SQLite transaction.
 */
export async function handleLeaveQueue(
  client: Client,
  channelId: string,
  user: User
): Promise<QueueClickResult> {
  // The queue row is the only thing here that knows which guild this channel belongs to.
  const existingQueue = getQueue(channelId);
  if (!existingQueue) {
    return { success: false, message: 'No active queue in this channel.' };
  }

  const activeMatch = getActiveMatchForPlayer(existingQueue.guild_id, user.id);
  if (activeMatch) {
    return {
      success: false,
      message: `You cannot leave the queue while you are in active Match #${activeMatch.match_number} (Ready Check/Voting/Match)!`,
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

  const settled = refreshQueuePanel(client, channelId).catch(err =>
    logger.error(`Leave queue follow-up failed in ${channelId}:`, err)
  );

  return { success: true, message: 'Left the queue. 🚪', settled };
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
): Promise<QueueClickResult> {
  // A test fill only makes sense where a panel is. This used to create the row, and a
  // row is all the message listener needed to start re-posting panels into #general.
  const queue = getQueue(channelId);
  if (!queue) {
    return { success: false, message: '❌ There is no queue panel in this channel.' };
  }
  if (queue.state !== 'WAITING') {
    return { success: false, message: 'Queue has already popped!' };
  }

  // Eight of them, so a 4v4 queue can be filled as easily as a 2v2 one.
  const testBots = [
    { id: 'test_bot_1', name: 'Squishy (Bot)', mmr: 1250 },
    { id: 'test_bot_2', name: 'GarrettG (Bot)', mmr: 1350 },
    { id: 'test_bot_3', name: 'Jstn (Bot)', mmr: 1100 },
    { id: 'test_bot_4', name: 'MonkeyMoon (Bot)', mmr: 1400 },
    { id: 'test_bot_5', name: 'Vatira (Bot)', mmr: 1050 },
    { id: 'test_bot_6', name: 'Scrub Killa (Bot)', mmr: 1150 },
    { id: 'test_bot_7', name: 'Firstkiller (Bot)', mmr: 1300 },
    { id: 'test_bot_8', name: 'Zen (Bot)', mmr: 1200 },
  ];

  const capacity = queue.team_size * 2;

  for (const bot of testBots) {
    if (queue.player_ids.length >= capacity) break;
    if (!queue.player_ids.includes(bot.id)) {
      getOrCreatePlayer(queue.guild_id, queue.team_size, bot.id, bot.name);
      setPlayerMmr(queue.guild_id, queue.team_size, bot.id, bot.mmr);
      queue.player_ids.push(bot.id);
      queue.player_join_times = queue.player_join_times || {};
      queue.player_join_times[bot.id] = Date.now();
    }
  }

  saveQueue(queue);
  await refreshQueuePanel(client, channelId);

  if (queue.player_ids.length === capacity && !skipVoting) {
    await startReadyCheckPhase(client, channelId, guildId, queue);
  }

  return {
    success: true,
    message: `🤖 Filled queue with simulated bot players (${queue.player_ids.length}/${capacity})!`,
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
): Promise<QueueClickResult> {
  await fillQueueWithBots(client, channelId, guildId, true);

  const queue = getQueue(channelId);
  const capacity = (queue?.team_size ?? DEFAULT_TEAM_SIZE) * 2;
  if (!queue || queue.player_ids.length !== capacity) {
    return { success: false, message: `Could not fill queue to ${capacity} players.` };
  }

  const players = getPlayersByIds(queue.guild_id, queue.team_size, queue.player_ids);

  if (!mode) {
    await startReadyCheckPhase(client, channelId, guildId, queue);
    return { success: true, message: '🚀 Force-popped queue! Starting Ready Check...' };
  }

  // Create SQLite match record for force-pop mode
  const match = createMatch({
    guild_id: guildId,
    channel_id: channelId,
    team_size: queue.team_size,
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
    match,
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
      team_size: queue.team_size,
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
