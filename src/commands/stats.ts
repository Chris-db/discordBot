import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  AttachmentBuilder,
  MessageFlags,
} from 'discord.js';
import {
  getOrCreatePlayer,
  getLeaderboard,
  getTotalPlayersCount,
  setPlayerMmr,
  getMatchHistory,
} from '../database/queries';
import { addTeamSizeOption, getTeamSizeOption, formatTeamSize } from '../ui/teamSize';
import { getLeaderboardButtons } from '../ui/buttons';
import { generateLeaderboardImage } from '../services/leaderboardImage';
import { generatePlayerProfileImage } from '../services/profileImage';
import { loadProfileCard } from '../services/profileCard';
import { generateMatchHistoryImage } from '../services/historyImage';
import { autoDeleteReply } from '../utils/autoDelete';

export const statsCommand = {
  data: addTeamSizeOption(
    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Check player stats and MMR rating')
      .addUserOption(opt =>
        opt.setName('user').setDescription('The user whose stats to check (optional)')
      ),
    'Which ladder to show (defaults to 3v3)'
  ),

  async execute(interaction: ChatInputCommandInteraction) {
    // Canvas rendering plus avatar downloads can exceed Discord's 3s interaction
    // deadline on a cold avatar cache, which surfaces as "the application did not respond".
    await interaction.deferReply();

    const guildId = interaction.guildId!;
    const teamSize = getTeamSizeOption(interaction);
    const user = interaction.options.getUser('user') || interaction.user;
    const player = getOrCreatePlayer(guildId, teamSize, user.id, user.username);
    const imageBuffer = await generatePlayerProfileImage(interaction.client, loadProfileCard(guildId, teamSize, player));
    const fileName = `profile_${Date.now()}.png`;
    const attachment = new AttachmentBuilder(imageBuffer, { name: fileName });

    return interaction.editReply({ files: [attachment] });
  },
};

export const leaderboardCommand = {
  data: addTeamSizeOption(
    new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Display the ELO Leaderboard for a rank division')
      .addStringOption(opt =>
        opt
          .setName('division')
          .setDescription('Which division to show (defaults to your own)')
          .setRequired(false)
          .addChoices(
            { name: 'Rank C', value: 'C' },
            { name: 'Rank B', value: 'B' },
            { name: 'Rank A', value: 'A' },
            { name: 'Rank X', value: 'X' },
            { name: 'Rank S', value: 'S' }
          )
      ),
    'Which ladder to show (defaults to 3v3)'
  ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const guildId = interaction.guildId!;
    const teamSize = getTeamSizeOption(interaction);
    const page = 1;
    // Each division of each size has its own ladder, so an unqualified leaderboard would
    // mix populations that never play each other. Default to the caller's own division.
    const division =
      interaction.options.getString('division') ||
      getOrCreatePlayer(guildId, teamSize, interaction.user.id, interaction.user.username).division;
    const totalPlayers = getTotalPlayersCount(guildId, teamSize, division);
    const topPlayers = getLeaderboard(guildId, teamSize, division, 10, 0);

    const imageBuffer = await generateLeaderboardImage(
      interaction.client,
      topPlayers,
      page,
      teamSize
    );
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'leaderboard.png' });

    // The board image draws the ladder itself; page context is all that is left to say.
    const totalPages = Math.max(1, Math.ceil(totalPlayers / 10));
    const buttons = getLeaderboardButtons(page, totalPages);
    return interaction.editReply({
      content: `${formatTeamSize(teamSize)} · ${division} · Page ${page}/${totalPages} · ${totalPlayers} players`,
      components: [buttons],
      files: [attachment],
    });
  },
};

export const setMmrCommand = {
  data: addTeamSizeOption(
    new SlashCommandBuilder()
      .setName('set-mmr')
      .setDescription("Set a player's ELO rating (Admin/Mod)")
      .addUserOption(opt =>
        opt.setName('user').setDescription('The user to update').setRequired(true)
      )
      .addIntegerOption(opt =>
        opt
          .setName('mmr')
          .setDescription('The new MMR rating (e.g. 1000)')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(3000)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    'Which ladder to change (defaults to 3v3)'
  ),

  async execute(interaction: ChatInputCommandInteraction) {
    autoDeleteReply(interaction, 6000);
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({
        content: '❌ You need **Manage Channels** permission to change player MMR.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const user = interaction.options.getUser('user', true);
    const newMmr = interaction.options.getInteger('mmr', true);

    const guildId = interaction.guildId!;
    const teamSize = getTeamSizeOption(interaction);
    getOrCreatePlayer(guildId, teamSize, user.id, user.username);
    setPlayerMmr(guildId, teamSize, user.id, newMmr);

    return interaction.reply({
      content: `✅ Updated <@${user.id}>'s **${formatTeamSize(teamSize)}** rating to \`${newMmr} MMR\`.`,
    });
  },
};

export const historyCommand = {
  data: addTeamSizeOption(
    new SlashCommandBuilder()
      .setName('history')
      .setDescription('View completed match history')
      .addUserOption(opt =>
        opt.setName('user').setDescription('Optional player to filter match history for').setRequired(false)
      ),
    'Only show matches at this size (defaults to every size)'
  ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') || undefined;
    const guildId = interaction.guildId!;
    // History spans every size unless one is asked for -- unlike a rating, a list of past
    // games is still meaningful mixed together, and each card names its own size.
    const teamSize = interaction.options.getInteger('size') ?? undefined;
    const matches = getMatchHistory(guildId, 10, targetUser?.id, teamSize);

    const imageBuffer = await generateMatchHistoryImage(interaction.client, matches, targetUser);
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'history.png' });

    return interaction.editReply({
      files: [attachment],
    });
  },
};
