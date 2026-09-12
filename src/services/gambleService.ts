import { Client, ButtonInteraction, TextChannel, AttachmentBuilder, MessageFlags } from 'discord.js';
import {
  getMatch,
  getMatchByTextChannel,
  updateMatchGambleStatus,
  mutateMatchGambleStatus,
  getPlayersByIds,
  applyGambleResultToPlayer,
  GambleStatus,
  Match,
  Player,
} from '../database/queries';
import { cancelMatchChannelDeletion, scheduleMatchChannelDeletion } from './channelService';
import { buildGambleConsensusEmbed } from '../ui/embeds';
import { getGambleConsensusButtons } from '../ui/buttons';
import { generateGambleResultImage, GamblePlayerResult } from './gambleImage';
import { generateWheelSpinGif, WheelSpin } from './wheelImage';
import { logger } from '../utils/logger';

/** How long the roster has to reach unanimous agreement. */
const GAMBLE_WINDOW_MS = 60_000;

/**
 * How long the channel stays open once a proposal dies, and once the wheel has landed.
 *
 * Proposing used to leave completeMatch's 90-second teardown running underneath it. The
 * window is 60 seconds, so a proposal made 40 seconds after the result had its wheel spin
 * in a channel that no longer existed -- MMR doubled or inverted with nobody watching.
 * Proposing now cancels that teardown, and these two are its replacements.
 */
const TEARDOWN_AFTER_DEAD_PROPOSAL_MS = 30_000;
const TEARDOWN_AFTER_WHEEL_MS = 60_000;

const activeGambleTimers = new Map<number, NodeJS.Timeout>();
const activeGambleMessages = new Map<number, { channelId: string; messageId: string }>();

/**
 * When the window closes, in unix seconds for the card's `<t:…:R>`.
 *
 * Computed from the stored proposedAt -- the same instant the expiry timer is measured
 * from -- so every re-render of the card and the timer agree on one deadline. Each click
 * used to recompute a seconds-remaining figure, which only moved when someone clicked.
 */
function consensusDeadline(status: GambleStatus): number {
  return Math.floor(((status.proposedAt ?? Date.now()) + GAMBLE_WINDOW_MS) / 1000);
}

/**
 * Whether the post-match lobby is gone: a rematch has launched in its channel, or a player
 * has gone back to the queue. A gamble needs every player to agree and then rewrites the
 * result, so it cannot outlive either.
 *
 * Both of those set rematchResolved -- but so does a declined rematch vote, which leaves
 * the teams intact and the Double or Nothing button live. Hence the two concrete checks
 * rather than the flag alone.
 */
function lobbyBrokenUp(match: Match): boolean {
  if (!match.report_status.rematchResolved) return false;
  if ((match.report_status.requeued?.length ?? 0) > 0) return true;
  if (!match.text_channel_id) return false;
  const occupant = getMatchByTextChannel(match.text_channel_id);
  return !!occupant && occupant.match_id !== match.match_id;
}

function clearGambleTimer(matchId: number): void {
  const timer = activeGambleTimers.get(matchId);
  if (!timer) return;
  clearTimeout(timer);
  activeGambleTimers.delete(matchId);
}

/**
 * Puts the teardown back once the gamble no longer needs the channel.
 *
 * Unless a rematch has launched in it since: a rematch reuses these channels, so deleting
 * them now would pull a live match out from under six players. The rematch's own
 * completeMatch schedules the teardown when it ends.
 */
function rescheduleTeardown(client: Client, match: Match, delayMs: number): void {
  if (!match.text_channel_id) return;
  const occupant = getMatchByTextChannel(match.text_channel_id);
  if (occupant && occupant.match_id !== match.match_id) return;
  scheduleMatchChannelDeletion(client, match.match_id, delayMs);
}

/**
 * Ends a PROPOSED gamble without a spin. Returns the match, or undefined if there was no
 * open proposal to end -- the timer, a decline and a rematch can all race for this.
 */
function closeProposal(
  client: Client,
  matchId: number,
  mutate: (status: GambleStatus) => void
): Match | undefined {
  clearGambleTimer(matchId);
  activeGambleMessages.delete(matchId);

  let closed = false;
  const updated = mutateMatchGambleStatus(matchId, status => {
    if (status.state !== 'PROPOSED') return;
    mutate(status);
    closed = true;
  });
  if (!updated || !closed) return undefined;

  rescheduleTeardown(client, updated, TEARDOWN_AFTER_DEAD_PROPOSAL_MS);
  return updated;
}

/** Replaces the consensus card with a single line, for whoever is still looking at it. */
async function collapseProposalMessage(
  client: Client,
  matchId: number,
  ref: { channelId: string; messageId: string } | undefined,
  line: string
): Promise<void> {
  if (!ref) return;
  try {
    const channel = (await client.channels.fetch(ref.channelId).catch(() => null)) as TextChannel | null;
    const targetMsg = await channel?.messages.fetch(ref.messageId).catch(() => null);
    if (targetMsg) {
      await targetMsg.edit({ content: line, embeds: [], components: [] });
    }
  } catch (err) {
    logger.warn(`[Gamble] Failed to collapse consensus message for match id ${matchId}:`, err);
  }
}

/**
 * Kills an open proposal because the lobby has moved on -- see lobbyBrokenUp. startRematch
 * and handleRequeue call this at the point they break it up. Returns true if there was a
 * proposal to void.
 */
export async function voidPendingGamble(client: Client, matchId: number): Promise<boolean> {
  const ref = activeGambleMessages.get(matchId);
  const closed = closeProposal(client, matchId, status => {
    status.state = 'EXPIRED';
  });
  if (!closed) return false;

  await collapseProposalMessage(
    client,
    matchId,
    ref,
    '🚫 Double or Nothing is off — the lobby has moved on. The original result stands.'
  );
  return true;
}

/**
 * Initiates the Double or Nothing gamble proposal with a 60-second unanimous consensus window.
 */
export async function proposeGamble(
  client: Client,
  interaction: ButtonInteraction,
  matchId: number
): Promise<void> {
  const match = getMatch(matchId);
  if (!match || match.state !== 'COMPLETED') {
    await interaction.reply({
      content: '❌ This match is not eligible for Double or Nothing.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const isPlayer =
    match.blue_team.includes(interaction.user.id) ||
    match.orange_team.includes(interaction.user.id);

  if (!isPlayer) {
    await interaction.reply({
      content: '❌ Only players who participated in this match can propose Double or Nothing!',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The card disables this button when the lobby breaks up, but a click can already be in
  // flight -- and a gamble on a result that a rematch is busy replacing, or on teams that
  // no longer exist, must not open at all.
  if (lobbyBrokenUp(match)) {
    await interaction.reply({
      content: '❌ Double or Nothing is off — the lobby has already moved on to a rematch or the queue.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const status = match.gamble_status || { state: 'NONE', agreedPlayers: [] };
  if (status.state !== 'NONE' && status.state !== 'EXPIRED') {
    await interaction.reply({
      content: '❌ A Double or Nothing gamble has already been proposed or resolved for this match.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const newStatus: GambleStatus = {
    ...status,
    state: 'PROPOSED',
    proposedAt: Date.now(),
    proposedBy: interaction.user.id,
    agreedPlayers: [interaction.user.id],
  };

  updateMatchGambleStatus(matchId, newStatus);

  // The channel is now in use until the proposal is settled; see the teardown constants.
  cancelMatchChannelDeletion(matchId);

  const bluePlayers = getPlayersByIds(match.guild_id, match.team_size, match.blue_team);
  const orangePlayers = getPlayersByIds(match.guild_id, match.team_size, match.orange_team);

  const embed = buildGambleConsensusEmbed(
    match.match_number,
    bluePlayers,
    orangePlayers,
    newStatus.agreedPlayers,
    consensusDeadline(newStatus)
  );

  let msg;
  try {
    msg = await interaction.reply({
      embeds: [embed],
      components: [getGambleConsensusButtons(matchId, false)],
      fetchReply: true,
    });
  } catch (err) {
    // The card never reached the channel, so nobody can agree to it -- and the teardown
    // has just been cancelled on its behalf, so it must be closed out, not left PROPOSED.
    closeProposal(client, matchId, status => {
      status.state = 'EXPIRED';
    });
    logger.warn(`[Gamble] Could not post the proposal for match id ${matchId}:`, err);
    return;
  }

  const ref = { channelId: interaction.channelId, messageId: msg.id };
  activeGambleMessages.set(matchId, ref);

  // The delay is measured from proposedAt rather than from here, so the timer fires at
  // the instant the card's countdown reaches zero -- the reply above took real time.
  const timer = setTimeout(async () => {
    activeGambleTimers.delete(matchId);
    const closed = closeProposal(client, matchId, status => {
      status.state = 'EXPIRED';
    });
    if (!closed) return;

    // Nobody is going to act on an expired proposal, so it collapses to a line rather
    // than sitting there as a full card with a dead roster in it.
    await collapseProposalMessage(
      client,
      matchId,
      ref,
      '⏰ Double or Nothing expired — the original result stands.'
    );
  }, Math.max(0, newStatus.proposedAt! + GAMBLE_WINDOW_MS - Date.now()));

  activeGambleTimers.set(matchId, timer);
}

/**
 * Handles a player clicking "🤝 I Agree to Gamble".
 */
export async function handleGambleAgree(
  client: Client,
  interaction: ButtonInteraction,
  matchId: number
): Promise<void> {
  const match = getMatch(matchId);
  if (!match || match.gamble_status?.state !== 'PROPOSED') {
    await interaction.reply({
      content: '❌ No active Double or Nothing proposal is currently open for this match.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The rematch and requeue paths void the proposal themselves, but a click can land in
  // the gap between the lobby breaking up and the card being collapsed. This click is on
  // the card, so it does the collapsing.
  if (lobbyBrokenUp(match)) {
    closeProposal(client, matchId, status => {
      status.state = 'EXPIRED';
    });
    await interaction.update({
      content: '🚫 Double or Nothing is off — the lobby has moved on. The original result stands.',
      embeds: [],
      components: [],
    });
    return;
  }

  const isPlayer =
    match.blue_team.includes(interaction.user.id) ||
    match.orange_team.includes(interaction.user.id);

  if (!isPlayer) {
    await interaction.reply({
      content: '❌ Only players who participated in this match can vote!',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (match.gamble_status.agreedPlayers.includes(interaction.user.id)) {
    await interaction.reply({
      content: '✅ You have already agreed to the gamble!',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Atomic — six players racing to agree used to drop each other's agreements,
  // which meant the unanimous threshold could never be reached.
  const updated = mutateMatchGambleStatus(matchId, s => {
    if (!s.agreedPlayers.includes(interaction.user.id)) {
      s.agreedPlayers.push(interaction.user.id);
    }
  });
  if (!updated) return;
  const status = updated.gamble_status!;

  const bluePlayers = getPlayersByIds(match.guild_id, match.team_size, match.blue_team);
  const orangePlayers = getPlayersByIds(match.guild_id, match.team_size, match.orange_team);

  const embed = buildGambleConsensusEmbed(
    match.match_number,
    bluePlayers,
    orangePlayers,
    status.agreedPlayers,
    consensusDeadline(status)
  );

  await interaction.update({
    embeds: [embed],
    components: [getGambleConsensusButtons(matchId, false)],
  });

  // Everyone has to agree -- everyone who can click. This used to be a hardcoded 6, so a
  // 2v2 lobby could never reach consensus and a 4v4 spun two short of unanimous; then it
  // was the whole roster, so a lobby padded with `/queue fill-bots` could never spin, as
  // the bots never click. Test bots only enter a match through that admin command.
  const humans = [...match.blue_team, ...match.orange_team].filter(id => !id.startsWith('test_bot_'));
  const needed = Math.max(1, humans.length);
  if (status.agreedPlayers.length >= needed) {
    clearGambleTimer(matchId);
    activeGambleMessages.delete(matchId);

    await startWheelOfFate(client, matchId, interaction.channelId, interaction.message.id);
  }
}

/**
 * Handles a player clicking "🚫 Decline".
 */
export async function handleGambleDecline(
  client: Client,
  interaction: ButtonInteraction,
  matchId: number
): Promise<void> {
  const match = getMatch(matchId);
  if (!match || match.gamble_status?.state !== 'PROPOSED') {
    await interaction.reply({
      content: '❌ No active Double or Nothing proposal is open for this match.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const isPlayer =
    match.blue_team.includes(interaction.user.id) ||
    match.orange_team.includes(interaction.user.id);

  if (!isPlayer) {
    await interaction.reply({
      content: '❌ Only players in this match can decline!',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  closeProposal(client, matchId, status => {
    status.state = 'DECLINED';
    status.declinedBy = interaction.user.id;
  });

  // A declined proposal is over -- no roster, no stakes, just the outcome.
  await interaction.update({
    content: `<@${interaction.user.id}> declined. The original result stands.`,
    embeds: [],
    components: [],
  });
}

/**
 * Triggers the Wheel of Fate spinning animation and resolves the outcome.
 *
 * The teardown comes back in a finally: the proposal cancelled the original one, and a
 * failed result image must not leave the channel open for good.
 */
async function startWheelOfFate(
  client: Client,
  matchId: number,
  channelId: string,
  messageId: string
): Promise<void> {
  const match = getMatch(matchId);
  if (!match) return;

  try {
    await spinWheelOfFate(client, matchId, channelId, messageId);
  } finally {
    rescheduleTeardown(client, match, TEARDOWN_AFTER_WHEEL_MS);
  }
}

async function spinWheelOfFate(
  client: Client,
  matchId: number,
  channelId: string,
  messageId: string
): Promise<void> {
  const match = getMatch(matchId);
  if (!match) return;

  const status = match.gamble_status || { state: 'PROPOSED', agreedPlayers: [] };
  status.state = 'SPINNING';
  updateMatchGambleStatus(matchId, status);

  const channel = (await client.channels.fetch(channelId)) as TextChannel;
  if (!channel) return;
  const targetMsg = await channel.messages.fetch(messageId).catch(() => null);
  if (!targetMsg) return;

  // The 50/50 is decided before anything is drawn: the GIF has to land on the answer.
  const wheelWinner: 'BLUE' | 'ORANGE' = Math.random() < 0.5 ? 'BLUE' : 'ORANGE';
  const originalWinner = match.winner;

  // The spin replaces the consensus card. Discord loops the GIF, so once one play has
  // finished the result card takes its place. If the render fails the gamble still
  // resolves -- the MMR is what matters -- behind a plain line instead of a wheel.
  let spin: WheelSpin | undefined;
  try {
    spin = generateWheelSpinGif(match.match_number, wheelWinner);
  } catch (err) {
    logger.warn(`[Gamble] Could not render the spin for match id ${matchId}:`, err);
  }
  if (spin) {
    await targetMsg.edit({
      content: '',
      embeds: [],
      components: [],
      files: [new AttachmentBuilder(spin.buffer, { name: 'wheel_spin.gif' })],
      attachments: [],
    }).catch(() => null);
    // Measured from when Discord has the GIF, so viewers see the whole spin land.
    await new Promise((res) => setTimeout(res, spin!.durationMs + 500));
  } else {
    await targetMsg.edit({
      content: `🎡 Spinning the wheel — Match #${match.match_number}…`,
      embeds: [],
      components: [],
    }).catch(() => null);
    await new Promise((res) => setTimeout(res, 3000));
  }
  const resultType: 'INVERTED' | 'DOUBLED' =
    wheelWinner === originalWinner ? 'DOUBLED' : 'INVERTED';

  const blueDelta = status.blueDelta ?? 18;
  const orangeDelta = status.orangeDelta ?? -18;

  const bluePlayers = getPlayersByIds(match.guild_id, match.team_size, match.blue_team);
  const orangePlayers = getPlayersByIds(match.guild_id, match.team_size, match.orange_team);

  const blueResults: GamblePlayerResult[] = [];
  const orangeResults: GamblePlayerResult[] = [];

  // Apply MMR changes based on INVERTED vs DOUBLED
  for (const p of bluePlayers) {
    let mmrChange = 0;
    let winChange = 0;
    let lossChange = 0;
    let appliedDelta = 0;

    if (resultType === 'DOUBLED') {
      if (originalWinner === 'BLUE') {
        // Blue won original and won wheel (+18 more)
        mmrChange = Math.abs(blueDelta);
        appliedDelta = Math.abs(blueDelta) * 2;
      } else {
        // Blue lost original and lost wheel (-18 more)
        mmrChange = -Math.abs(blueDelta);
        appliedDelta = -Math.abs(blueDelta) * 2;
      }
    } else {
      // INVERTED
      if (originalWinner === 'BLUE') {
        // Blue won original (+18), now inverted to loser (-18): change is -36
        mmrChange = -Math.abs(blueDelta) * 2;
        winChange = -1;
        lossChange = 1;
        appliedDelta = -Math.abs(blueDelta);
      } else {
        // Blue lost original (-18), now inverted to winner (+18): change is +36
        mmrChange = Math.abs(blueDelta) * 2;
        winChange = 1;
        lossChange = -1;
        appliedDelta = Math.abs(blueDelta);
      }
    }

    const updatedPlayer = applyGambleResultToPlayer(match.guild_id, match.team_size, p.discord_id, mmrChange, winChange, lossChange);
    blueResults.push({
      player: updatedPlayer,
      delta: appliedDelta,
      newMmr: updatedPlayer.mmr,
    });
  }

  for (const p of orangePlayers) {
    let mmrChange = 0;
    let winChange = 0;
    let lossChange = 0;
    let appliedDelta = 0;

    if (resultType === 'DOUBLED') {
      if (originalWinner === 'ORANGE') {
        mmrChange = Math.abs(orangeDelta);
        appliedDelta = Math.abs(orangeDelta) * 2;
      } else {
        mmrChange = -Math.abs(orangeDelta);
        appliedDelta = -Math.abs(orangeDelta) * 2;
      }
    } else {
      // INVERTED
      if (originalWinner === 'ORANGE') {
        mmrChange = -Math.abs(orangeDelta) * 2;
        winChange = -1;
        lossChange = 1;
        appliedDelta = -Math.abs(orangeDelta);
      } else {
        mmrChange = Math.abs(orangeDelta) * 2;
        winChange = 1;
        lossChange = -1;
        appliedDelta = Math.abs(orangeDelta);
      }
    }

    const updatedPlayer = applyGambleResultToPlayer(match.guild_id, match.team_size, p.discord_id, mmrChange, winChange, lossChange);
    orangeResults.push({
      player: updatedPlayer,
      delta: appliedDelta,
      newMmr: updatedPlayer.mmr,
    });
  }

  // Update match record
  status.state = 'RESOLVED';
  status.wheelWinner = wheelWinner;
  status.resultType = resultType;
  updateMatchGambleStatus(matchId, status);

  // Generate victory image
  const imageBuffer = await generateGambleResultImage(
    client,
    match.match_number,
    wheelWinner,
    resultType,
    blueResults,
    orangeResults,
    spin?.landingAngle
  );

  const attachment = new AttachmentBuilder(imageBuffer, { name: 'wheel_result.png' });

  // The result image draws the outcome, which team won the 50/50, and every player's new
  // MMR and delta -- so the message is the image and nothing else.
  await targetMsg.edit({
    content: '',
    embeds: [],
    files: [attachment],
    attachments: [],
    components: [],
  }).catch((err) => {
    logger.error(`[Gamble] Failed to post resolved wheel image for match id ${matchId}:`, err);
  });
}
