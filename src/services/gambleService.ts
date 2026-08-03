import {
  Client,
  ButtonInteraction,
  TextChannel,
  AttachmentBuilder,
  EmbedBuilder,
} from 'discord.js';
import {
  getMatch,
  updateMatchGambleStatus,
  mutateMatchGambleStatus,
  getPlayersByIds,
  applyGambleResultToPlayer,
  GambleStatus,
  Player,
} from '../database/queries';
import {
  buildGambleConsensusEmbed,
  buildGambleSpinningEmbed,
  RL_COLORS,
} from '../ui/embeds';
import { getGambleConsensusButtons } from '../ui/buttons';
import { generateGambleResultImage, GamblePlayerResult } from './gambleImage';
import { logger } from '../utils/logger';

const activeGambleTimers = new Map<number, NodeJS.Timeout>();
const activeGambleMessages = new Map<number, { channelId: string; messageId: string }>();

/**
 * Initiates the Double or Nothing gamble proposal with a 60-second 6/6 consensus window.
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
      ephemeral: true,
    });
    return;
  }

  const isPlayer =
    match.blue_team.includes(interaction.user.id) ||
    match.orange_team.includes(interaction.user.id);

  if (!isPlayer) {
    await interaction.reply({
      content: '❌ Only players who participated in this match can propose Double or Nothing!',
      ephemeral: true,
    });
    return;
  }

  const status = match.gamble_status || { state: 'NONE', agreedPlayers: [] };
  if (status.state !== 'NONE' && status.state !== 'EXPIRED') {
    await interaction.reply({
      content: '❌ A Double or Nothing gamble has already been proposed or resolved for this match.',
      ephemeral: true,
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

  const bluePlayers = getPlayersByIds(match.blue_team);
  const orangePlayers = getPlayersByIds(match.orange_team);

  const embed = buildGambleConsensusEmbed(
    matchId,
    bluePlayers,
    orangePlayers,
    newStatus.agreedPlayers,
    60
  );

  const msg = await interaction.reply({
    embeds: [embed],
    components: [getGambleConsensusButtons(matchId, false)],
    fetchReply: true,
  });

  activeGambleMessages.set(matchId, {
    channelId: interaction.channelId,
    messageId: msg.id,
  });

  // Start 60s timer
  const timer = setTimeout(async () => {
    activeGambleTimers.delete(matchId);
    const m = getMatch(matchId);
    if (!m || m.gamble_status?.state !== 'PROPOSED') return;

    updateMatchGambleStatus(matchId, {
      ...m.gamble_status,
      state: 'EXPIRED',
    });

    try {
      const channel = (await client.channels.fetch(interaction.channelId)) as TextChannel;
      if (channel) {
        const targetMsg = await channel.messages.fetch(msg.id).catch(() => null);
        if (targetMsg) {
          const expiredEmbed = EmbedBuilder.from(embed)
            .setColor(RL_COLORS.DARK)
            .setDescription(
              '⏰ **The 60-second Double or Nothing consensus window has expired.**\n' +
                'Not all 6 players agreed in time. The original match result stands permanently!'
            )
            .setFooter({ text: 'Consensus Expired • Match Finalized' });

          await targetMsg.edit({
            embeds: [expiredEmbed],
            components: [getGambleConsensusButtons(matchId, true)],
          });
        }
      }
    } catch (err) {
      logger.warn(`[Gamble] Failed to edit expired consensus message for Match #${matchId}:`, err);
    }
  }, 60000);

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
      ephemeral: true,
    });
    return;
  }

  const isPlayer =
    match.blue_team.includes(interaction.user.id) ||
    match.orange_team.includes(interaction.user.id);

  if (!isPlayer) {
    await interaction.reply({
      content: '❌ Only players who participated in this match can vote!',
      ephemeral: true,
    });
    return;
  }

  if (match.gamble_status.agreedPlayers.includes(interaction.user.id)) {
    await interaction.reply({
      content: '✅ You have already agreed to the gamble!',
      ephemeral: true,
    });
    return;
  }

  // Atomic — six players racing to agree used to drop each other's agreements,
  // which meant the 6/6 threshold could never be reached.
  const updated = mutateMatchGambleStatus(matchId, s => {
    if (!s.agreedPlayers.includes(interaction.user.id)) {
      s.agreedPlayers.push(interaction.user.id);
    }
  });
  if (!updated) return;
  const status = updated.gamble_status!;

  const bluePlayers = getPlayersByIds(match.blue_team);
  const orangePlayers = getPlayersByIds(match.orange_team);

  const elapsedSec = Math.floor((Date.now() - (status.proposedAt || Date.now())) / 1000);
  const remSec = Math.max(1, 60 - elapsedSec);

  const embed = buildGambleConsensusEmbed(
    matchId,
    bluePlayers,
    orangePlayers,
    status.agreedPlayers,
    remSec
  );

  await interaction.update({
    embeds: [embed],
    components: [getGambleConsensusButtons(matchId, false)],
  });

  // Check if 6/6 reached
  if (status.agreedPlayers.length >= 6) {
    const timer = activeGambleTimers.get(matchId);
    if (timer) {
      clearTimeout(timer);
      activeGambleTimers.delete(matchId);
    }

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
      ephemeral: true,
    });
    return;
  }

  const isPlayer =
    match.blue_team.includes(interaction.user.id) ||
    match.orange_team.includes(interaction.user.id);

  if (!isPlayer) {
    await interaction.reply({
      content: '❌ Only players in this match can decline!',
      ephemeral: true,
    });
    return;
  }

  const timer = activeGambleTimers.get(matchId);
  if (timer) {
    clearTimeout(timer);
    activeGambleTimers.delete(matchId);
  }

  const status = match.gamble_status;
  status.state = 'DECLINED';
  status.declinedBy = interaction.user.id;
  updateMatchGambleStatus(matchId, status);

  const bluePlayers = getPlayersByIds(match.blue_team);
  const orangePlayers = getPlayersByIds(match.orange_team);

  const embed = buildGambleConsensusEmbed(
    matchId,
    bluePlayers,
    orangePlayers,
    status.agreedPlayers,
    0,
    interaction.user.id
  );

  await interaction.update({
    embeds: [embed],
    components: [getGambleConsensusButtons(matchId, true)],
  });
}

/**
 * Triggers the Wheel of Fate spinning animation and resolves the outcome.
 */
async function startWheelOfFate(
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

  // Step 1: Spinning
  const step1Embed = buildGambleSpinningEmbed(1, matchId);
  await targetMsg.edit({
    embeds: [step1Embed],
    components: [],
  }).catch(() => null);

  await new Promise((res) => setTimeout(res, 2000));

  // Step 2: Slowdown
  const step2Embed = buildGambleSpinningEmbed(2, matchId);
  await targetMsg.edit({
    embeds: [step2Embed],
    components: [],
  }).catch(() => null);

  await new Promise((res) => setTimeout(res, 2000));

  // Step 3: Resolve Winner (50/50)
  const wheelWinner: 'BLUE' | 'ORANGE' = Math.random() < 0.5 ? 'BLUE' : 'ORANGE';
  const originalWinner = match.winner;
  const resultType: 'INVERTED' | 'DOUBLED' =
    wheelWinner === originalWinner ? 'DOUBLED' : 'INVERTED';

  const blueDelta = status.blueDelta ?? 18;
  const orangeDelta = status.orangeDelta ?? -18;

  const bluePlayers = getPlayersByIds(match.blue_team);
  const orangePlayers = getPlayersByIds(match.orange_team);

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

    const updatedPlayer = applyGambleResultToPlayer(p.discord_id, mmrChange, winChange, lossChange);
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

    const updatedPlayer = applyGambleResultToPlayer(p.discord_id, mmrChange, winChange, lossChange);
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
    matchId,
    wheelWinner,
    resultType,
    blueResults,
    orangeResults
  );

  const attachment = new AttachmentBuilder(imageBuffer, { name: 'wheel_result.png' });

  const finalTitle =
    resultType === 'INVERTED'
      ? `💥 WHEEL OF FATE: RESULT INVERTED! (Team ${wheelWinner === 'BLUE' ? 'Blue 🔵' : 'Orange 🟠'})`
      : `🔥 WHEEL OF FATE: JACKPOT DOUBLED! (Team ${wheelWinner === 'BLUE' ? 'Blue 🔵' : 'Orange 🟠'})`;

  const finalEmbed = new EmbedBuilder()
    .setTitle(finalTitle)
    .setColor(resultType === 'INVERTED' ? RL_COLORS.GOLD : RL_COLORS.RED)
    .setDescription(
      resultType === 'INVERTED'
        ? `🛡️ **THE VICTORY WAS STOLEN!**\nTeam ${wheelWinner === 'BLUE' ? 'Blue 🔵' : 'Orange 🟠'} won the Wheel of Fate spin! Original match results have been **INVERTED**.`
        : `🔥 **JACKPOT FOR THE WINNERS!**\nTeam ${wheelWinner === 'BLUE' ? 'Blue 🔵' : 'Orange 🟠'} won the Wheel of Fate spin! Original MMR deltas have been **DOUBLED**!`
    )
    .setImage('attachment://wheel_result.png')
    .setFooter({ text: 'Wheel of Fate • Official Result' })
    .setTimestamp();

  await targetMsg.edit({
    content: `🎲 **DOUBLE OR NOTHING RESOLVED!**`,
    embeds: [finalEmbed],
    files: [attachment],
    components: [],
  }).catch((err) => {
    logger.error(`[Gamble] Failed to post resolved wheel embed for Match #${matchId}:`, err);
  });
}
