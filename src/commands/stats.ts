import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  AttachmentBuilder,
} from 'discord.js';
import {
  getOrCreatePlayer,
  getLeaderboard,
  getTotalPlayersCount,
  getPlayerRank,
  setPlayerMmr,
  getMatchHistory,
} from '../database/queries';
import { buildStatsEmbed, buildLeaderboardEmbed, buildMatchHistoryEmbed } from '../ui/embeds';
import { getLeaderboardButtons } from '../ui/buttons';
import { generateLeaderboardImage } from '../services/leaderboardImage';
import { generatePlayerProfileImage } from '../services/profileImage';
import { generateMatchHistoryImage } from '../services/historyImage';
import { autoDeleteReply } from '../utils/autoDelete';

export const statsCommand = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Check 6mans player stats and MMR rating')
    .addUserOption(opt =>
      opt.setName('user').setDescription('The user whose stats to check (optional)')
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const user = interaction.options.getUser('user') || interaction.user;
    const player = getOrCreatePlayer(user.id, user.username);
    const rankData = getPlayerRank(player.discord_id);
    const rank = rankData ? rankData.rank : 0;
    const totalPlayers = getTotalPlayersCount();

    const imageBuffer = await generatePlayerProfileImage(
      interaction.client,
      player,
      rank,
      totalPlayers
    );
    const fileName = `profile_${Date.now()}.png`;
    const attachment = new AttachmentBuilder(imageBuffer, { name: fileName });

    const avatarUrl = user.displayAvatarURL({ size: 256 });
    const embed = buildStatsEmbed(player, rank, totalPlayers, avatarUrl);
    embed.setImage(`attachment://${fileName}`);
    return interaction.reply({ embeds: [embed], files: [attachment] });
  },
};

export const leaderboardCommand = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Display the server ELO Leaderboard'),

  async execute(interaction: ChatInputCommandInteraction) {
    const page = 1;
    const totalPlayers = getTotalPlayersCount();
    const topPlayers = getLeaderboard(10, 0);

    let topPlayerAvatarUrl: string | undefined;
    if (topPlayers.length > 0) {
      try {
        const topUser = await interaction.client.users.fetch(topPlayers[0].discord_id);
        topPlayerAvatarUrl = topUser.displayAvatarURL({ size: 256 });
      } catch {
        // ignore if user fetch fails
      }
    }

    const imageBuffer = await generateLeaderboardImage(interaction.client, topPlayers, page);
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'leaderboard.png' });

    const embed = buildLeaderboardEmbed(topPlayers, page, totalPlayers, topPlayerAvatarUrl, true);
    const buttons = getLeaderboardButtons(page, Math.max(1, Math.ceil(totalPlayers / 10)));
    return interaction.reply({ embeds: [embed], components: [buttons], files: [attachment] });
  },
};

export const setMmrCommand = {
  data: new SlashCommandBuilder()
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

  async execute(interaction: ChatInputCommandInteraction) {
    autoDeleteReply(interaction, 6000);
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({
        content: '❌ You need **Manage Channels** permission to change player MMR.',
        ephemeral: true,
      });
    }

    const user = interaction.options.getUser('user', true);
    const newMmr = interaction.options.getInteger('mmr', true);

    getOrCreatePlayer(user.id, user.username);
    setPlayerMmr(user.id, newMmr);

    return interaction.reply({
      content: `✅ Updated <@${user.id}>'s rating to \`${newMmr} MMR\`.`,
    });
  },
};

export const historyCommand = {
  data: new SlashCommandBuilder()
    .setName('history')
    .setDescription('View completed 6mans match history')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Optional player to filter match history for').setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const targetUser = interaction.options.getUser('user') || undefined;
    const guildId = interaction.guildId!;
    const matches = getMatchHistory(guildId, 10, targetUser?.id);

    const imageBuffer = await generateMatchHistoryImage(interaction.client, matches, targetUser);
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'history.png' });
    const embed = buildMatchHistoryEmbed(matches, targetUser);

    return interaction.reply({
      embeds: [embed],
      files: [attachment],
    });
  },
};
