import {
  Interaction,
  ButtonInteraction,
  StringSelectMenuInteraction,
  PermissionFlagsBits,
  AttachmentBuilder,
  Message,
  MessageFlags,
} from 'discord.js';
import {
  handleJoinQueue,
  handleLeaveQueue,
  handleModeVote,
  handleCaptainsVote,
  handleTeamsVote,
  handleCaptainPick,
} from '../services/queueService';
import { channelTeamSize } from '../services/queuePanel';
import { handleReadyCheckLeave } from '../services/readyCheckService';
import {
  handleMatchReportVote,
  handleMatchCancelVote,
} from '../services/matchService';
import {
  proposeGamble,
  handleGambleAgree,
  handleGambleDecline,
} from '../services/gambleService';
import { handleRematchVote, handleRequeue } from '../services/rematchService';
import {
  getOrCreatePlayer,
  getLeaderboard,
  getTotalPlayersCount,
  getMatch,
  getMatchHistory,
} from '../database/queries';
import { getLeaderboardButtons } from '../ui/buttons';
import { generateLeaderboardImage } from '../services/leaderboardImage';
import { generatePlayerProfileImage } from '../services/profileImage';
import { loadProfileCard } from '../services/profileCard';
import { generateMatchHistoryImage } from '../services/historyImage';
import { autoDeleteReply } from '../utils/autoDelete';
import { logger } from '../utils/logger';

/**
 * Handles all button click interactions.
 */
export async function handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId;
  const channelId = interaction.channelId;
  const guildId = interaction.guildId!;
  const user = interaction.user;

  try {
    // 1. Queue Panel Buttons
    // Join and Leave answer before the panel re-renders. The decision is a single SQLite
    // write, so there is nothing to defer for; deferring and then waiting on the panel
    // (three round trips and an image upload) is what kept "thinking" on screen for a
    // second. The follow-up is still awaited afterwards so its errors land in this catch.
    if (customId === 'queue_join') {
      autoDeleteReply(interaction, 6000);
      const res = await handleJoinQueue(interaction.client, channelId, guildId, user);
      await interaction.reply({ content: res.message, flags: MessageFlags.Ephemeral });
      await res.settled;
      return;
    }

    if (customId === 'queue_leave') {
      autoDeleteReply(interaction, 6000);
      const res = await handleLeaveQueue(interaction.client, channelId, user);
      await interaction.reply({ content: res.message, flags: MessageFlags.Ephemeral });
      await res.settled;
      return;
    }

    if (customId.startsWith('ready_leave_')) {
      const matchId = parseInt(customId.split('_').pop()!, 10);
      if (Number.isNaN(matchId)) {
        await interaction.reply({ content: '❌ Malformed button id.', flags: MessageFlags.Ephemeral });
        return;
      }
      autoDeleteReply(interaction, 6000);
      // Failing the check tears channels down and may re-pop the queue, well past 3s.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await handleReadyCheckLeave(matchId, user.id);
      await interaction.editReply({ content: res.message });
      return;
    }

    if (customId === 'queue_stats' || customId === 'leaderboard_my_rank') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guildId = interaction.guildId!;
      const teamSize = channelTeamSize(guildId, channelId);
      const player = getOrCreatePlayer(guildId, teamSize, user.id, user.username);
      const imageBuffer = await generatePlayerProfileImage(interaction.client, loadProfileCard(guildId, teamSize, player));
      const fileName = `profile_${Date.now()}.png`;
      const attachment = new AttachmentBuilder(imageBuffer, { name: fileName });

      // The profile image draws the name, tier, standing, MMR progress and the four stat
      // cards -- the embed was the same numbers again in list form.
      await interaction.editReply({
        files: [attachment],
      });
      return;
    }

    if (customId === 'queue_leaderboard') {
      // Defer first — image generation can outrun the 3s interaction deadline.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const page = 1;
      const guildId = interaction.guildId!;
      // Each division has its own ladder; show the caller theirs.
      const teamSize = channelTeamSize(guildId, channelId);
      const division = getOrCreatePlayer(guildId, teamSize, user.id, user.username).division;
      const totalPlayers = getTotalPlayersCount(guildId, teamSize, division);
      const topPlayers = getLeaderboard(guildId, teamSize, division, 10, 0);

      const imageBuffer = await generateLeaderboardImage(interaction.client, topPlayers, page);
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'leaderboard.png' });

      // Page context is the one thing the image does not draw, so it is the one thing
      // left in the text.
      const totalPages = Math.max(1, Math.ceil(totalPlayers / 10));
      const buttons = getLeaderboardButtons(page, totalPages);
      await interaction.editReply({
        content: `Page ${page}/${totalPages} · ${totalPlayers} players`,
        components: [buttons],
        files: [attachment],
      });
      return;
    }

    if (customId === 'queue_history') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guildId = interaction.guildId!;
      const matches = getMatchHistory(guildId, 10);
      const imageBuffer = await generateMatchHistoryImage(interaction.client, matches);
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'history.png' });

      await interaction.editReply({
        files: [attachment],
      });
      return;
    }

    if (
      customId.startsWith('leaderboard_prev_') ||
      customId.startsWith('leaderboard_next_') ||
      customId.startsWith('leaderboard_refresh_')
    ) {
      const currentPage = parseInt(customId.split('_').pop() || '1', 10);
      const guildId = interaction.guildId!;
      const teamSize = channelTeamSize(guildId, channelId);
      const division = getOrCreatePlayer(guildId, teamSize, user.id, user.username).division;
      const totalPlayers = getTotalPlayersCount(guildId, teamSize, division);
      const totalPages = Math.max(1, Math.ceil(totalPlayers / 10));

      let newPage = currentPage;
      if (customId.startsWith('leaderboard_prev_')) {
        newPage = Math.max(1, currentPage - 1);
      } else if (customId.startsWith('leaderboard_next_')) {
        newPage = Math.min(totalPages, currentPage + 1);
      }

      const topPlayers = getLeaderboard(guildId, teamSize, division, 10, (newPage - 1) * 10);

      const imageBuffer = await generateLeaderboardImage(interaction.client, topPlayers, newPage);
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'leaderboard.png' });

      const buttons = getLeaderboardButtons(newPage, totalPages);
      await interaction.update({
        content: `Page ${newPage}/${totalPages} · ${totalPlayers} players`,
        embeds: [],
        components: [buttons],
        files: [attachment],
        attachments: [],
      });
      return;
    }

    // 2. Captain Verification Vote Buttons
    if (customId === 'captains_verify_yes' || customId === 'captains_verify_no') {
      autoDeleteReply(interaction, 6000);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const vote = customId === 'captains_verify_yes' ? 'yes' : 'no';
      const res = await handleCaptainsVote(
        interaction.client,
        channelId,
        guildId,
        user.id,
        vote,
        interaction.message
      );
      await interaction.editReply({ content: res.message });
      return;
    }

    // 2b. Team Verification Vote Buttons (Random / Balanced Teams)
    if (customId === 'teams_verify_yes' || customId === 'teams_verify_no') {
      autoDeleteReply(interaction, 6000);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const vote = customId === 'teams_verify_yes' ? 'yes' : 'no';
      const res = await handleTeamsVote(
        interaction.client,
        channelId,
        guildId,
        user.id,
        vote,
        interaction.message
      );
      await interaction.editReply({ content: res.message });
      return;
    }

    // 3. Mode Vote Buttons
    if (customId.startsWith('vote_')) {
      autoDeleteReply(interaction, 6000);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const mode = customId.replace('vote_', '') as 'captains' | 'balanced' | 'random';
      const res = await handleModeVote(
        interaction.client,
        channelId,
        guildId,
        user.id,
        mode,
        interaction.message
      );
      await interaction.editReply({ content: res.message });
      return;
    }

    // 3. Match Action Buttons
    if (customId.startsWith('match_report_blue_') || customId.startsWith('match_report_orange_')) {
      autoDeleteReply(interaction, 6000);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const matchId = parseInt(customId.split('_').pop()!, 10);
      const winner = customId.includes('_blue_') ? 'BLUE' : 'ORANGE';
      const res = await handleMatchReportVote(interaction.client, matchId, user.id, winner);
      await interaction.editReply({ content: res.message });
      return;
    }

    if (customId.startsWith('match_cancel_')) {
      autoDeleteReply(interaction, 6000);
      const matchId = parseInt(customId.split('_').pop()!, 10);
      const match = getMatch(matchId);

      // This button is a player vote. It used to wave admins through as well, and then
      // the vote handler rejected them as non-players -- a dead end in two steps.
      const isPlayer = match && (match.blue_team.includes(user.id) || match.orange_team.includes(user.id));
      if (!isPlayer) {
        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
        await interaction.reply({
          content: isAdmin
            ? '❌ Cancel is a player vote. Use `/match cancel` to force it.'
            : '❌ Only players in this match can vote to cancel.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await handleMatchCancelVote(interaction.client, matchId, user.id);
      await interaction.editReply({ content: res.message });
      return;
    }

    // Mod overrides moved to /match report and /match cancel: a button on the match card
    // is visible to every player, and Discord can hide a slash command by permission.

    // 4. Gamble Actions
    if (customId.startsWith('gamble_propose_')) {
      const matchId = parseInt(customId.split('_').pop()!, 10);
      await proposeGamble(interaction.client, interaction, matchId);
      return;
    }

    if (customId.startsWith('gamble_agree_')) {
      const matchId = parseInt(customId.split('_').pop()!, 10);
      await handleGambleAgree(interaction.client, interaction, matchId);
      return;
    }

    if (customId.startsWith('gamble_decline_')) {
      const matchId = parseInt(customId.split('_').pop()!, 10);
      await handleGambleDecline(interaction.client, interaction, matchId);
      return;
    }

    // 6. Post-match actions: run it back, or go back to the queue.
    if (customId.startsWith('rematch_yes_') || customId.startsWith('rematch_no_')) {
      const matchId = parseInt(customId.split('_').pop()!, 10);
      if (Number.isNaN(matchId)) {
        await interaction.reply({ content: '❌ Malformed button id.', flags: MessageFlags.Ephemeral });
        return;
      }
      autoDeleteReply(interaction, 6000);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await handleRematchVote(
        interaction.client,
        matchId,
        user.id,
        customId.startsWith('rematch_yes_') ? 'yes' : 'no',
        interaction.message as Message
      );
      await interaction.editReply({ content: res.message });
      return;
    }

    if (customId.startsWith('requeue_')) {
      const matchId = parseInt(customId.split('_').pop()!, 10);
      if (Number.isNaN(matchId)) {
        await interaction.reply({ content: '❌ Malformed button id.', flags: MessageFlags.Ephemeral });
        return;
      }
      autoDeleteReply(interaction, 6000);
      // Re-adding six players and re-rendering the queue panel can outrun the 3s window.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await handleRequeue(
        interaction.client,
        matchId,
        user.id,
        interaction.message as Message
      );
      await interaction.editReply({ content: res.message });
      return;
    }
  } catch (error: any) {
    // 10062 = the interaction token already expired. Replying again just throws a second
    // error, so log it as a warning and move on rather than burying the real cause.
    if (error?.code === 10062) {
      logger.warn(
        `Interaction ${customId} expired before the bot could respond (Discord's 3s window). ` +
          `Usually means the event loop was blocked — check for a slow image render.`
      );
      return;
    }

    logger.error(`Error handling button interaction ${customId}:`, error);
    // A deferred reply must still be finished, or the clicker sees "thinking…" until the
    // token expires -- and autoDeleteReply only starts once something is actually sent.
    const content = '❌ An error occurred.';
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content }).catch(() => null);
    } else if (!interaction.replied) {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  }
}

/**
 * Handles Captains Draft Select Menu interactions.
 */
export async function handleSelectMenuInteraction(
  interaction: StringSelectMenuInteraction
): Promise<void> {
  const customId = interaction.customId;
  const channelId = interaction.channelId;
  const userId = interaction.user.id;

  if (customId === 'draft_select_player') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const selectedPlayerId = interaction.values[0];
    const res = await handleCaptainPick(
      interaction.client,
      channelId,
      userId,
      selectedPlayerId,
      interaction.message
    );
    await interaction.editReply({ content: res.message });
    return;
  }
}

/**
 * Main interaction routing router.
 */
export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
  } else if (interaction.isStringSelectMenu()) {
    await handleSelectMenuInteraction(interaction);
  }
}
