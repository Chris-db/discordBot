import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
} from 'discord.js';
import {
  getDivisions,
  getDivision,
  getOrCreatePlayer,
  getPlayer,
  setPlayerDivision,
  getTotalPlayersCount,
  updateDivision,
} from '../database/queries';
import { getDivisionTier } from '../services/mmrService';
import { addTeamSizeOption, getTeamSizeOption, formatTeamSize } from '../ui/teamSize';
import { SUPPORTED_TEAM_SIZES } from '../database/migrations';
import { logger } from '../utils/logger';

const DIVISION_CHOICES = [
  { name: 'Rank C', value: 'C' },
  { name: 'Rank B', value: 'B' },
  { name: 'Rank A', value: 'A' },
  { name: 'Rank X', value: 'X' },
  { name: 'Rank S', value: 'S' },
];

export const divisionCommand = {
  data: new SlashCommandBuilder()
    .setName('division')
    .setDescription('View rank divisions and place players into them')
    .addSubcommand(sub =>
      addTeamSizeOption(
        sub.setName('list').setDescription('Show every division, its thresholds and its channel'),
        'Only show this size (defaults to every size)'
      )
    )
    .addSubcommand(sub =>
      addTeamSizeOption(
        sub
          .setName('check')
          .setDescription("Show a player's current division")
          .addUserOption(opt =>
            opt.setName('user').setDescription('Player to check (defaults to you)').setRequired(false)
          )
      )
    )
    .addSubcommand(sub =>
      addTeamSizeOption(
        sub
          .setName('place')
          .setDescription('Place a player into a division (Admin)')
          .addUserOption(opt => opt.setName('user').setDescription('Player to place').setRequired(true))
          .addStringOption(opt =>
            opt
              .setName('division')
              .setDescription('Division to place them in')
              .setRequired(true)
              .addChoices(...DIVISION_CHOICES)
          )
          .addBooleanOption(opt =>
            opt
              .setName('keep-mmr')
              .setDescription('Keep their current MMR instead of resetting to the division default')
              .setRequired(false)
          ),
        'Which ladder to place them on (defaults to 3v3)'
      )
    )
    .addSubcommand(sub =>
      addTeamSizeOption(
        sub
          .setName('configure')
          .setDescription("Set a division's queue channel, role, or thresholds (Admin)")
          .addStringOption(opt =>
            opt
              .setName('division')
              .setDescription('Division to configure')
              .setRequired(true)
              .addChoices(...DIVISION_CHOICES)
          )
          .addChannelOption(opt =>
            opt
              .setName('queue-channel')
              .setDescription('Channel this division queues in at this size')
              .setRequired(false)
          )
          .addRoleOption(opt =>
            opt.setName('role').setDescription('Role that gates this division').setRequired(false)
          )
          .addIntegerOption(opt =>
            opt.setName('default-mmr').setDescription('Starting MMR each season').setRequired(false)
          )
          .addIntegerOption(opt =>
            opt.setName('promote-at').setDescription('Season-end MMR that promotes').setRequired(false)
          )
          .addIntegerOption(opt =>
            opt
              .setName('relegate-below')
              .setDescription('Season-end MMR that relegates')
              .setRequired(false)
          ),
        'Which ladder to configure (defaults to 3v3)'
      )
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    if (sub === 'list') {
      // Without a size, show every ladder -- seeing which channel drives which is the
      // main reason to run this once there is more than one size in play.
      const requestedSize = interaction.options.getInteger('size');
      const sizes = requestedSize ? [requestedSize] : [...SUPPORTED_TEAM_SIZES];

      const embed = new EmbedBuilder()
        .setColor(0xaa00ff)
        .setTitle('🏆 Rank Divisions')
        .setDescription(
          'Each division at each size has its own queue, its own ladder, and its own reset.'
        )
        .setTimestamp();

      let any = false;
      for (const size of sizes) {
        const divisions = getDivisions(guildId, size);
        if (divisions.length === 0) continue;
        any = true;

        for (const d of divisions) {
          const tier = getDivisionTier(d.division);
          const count = getTotalPlayersCount(guildId, size, d.division);
          const lines = [
            `Players: **${count}**  •  Season start: **${d.default_mmr} MMR**`,
            `Promotes at: ${d.promote_at !== null ? `**${d.promote_at}**` : '— (top division)'}`,
            `Relegates below: ${d.relegate_below !== null ? `**${d.relegate_below}**` : '— (bottom division)'}`,
            `Queue: ${d.queue_channel_id ? `<#${d.queue_channel_id}>` : '*not set*'}`,
            `Role: ${d.role_id ? `<@&${d.role_id}>` : '*not set*'}`,
          ];
          embed.addFields({
            name: `${tier.emoji} ${d.display_name} — ${formatTeamSize(size)}`,
            value: lines.join('\n'),
            inline: false,
          });
        }
      }

      if (!any) {
        await interaction.reply({
          content: '❌ No divisions configured for this server.',
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'check') {
      const teamSize = getTeamSizeOption(interaction);
      const user = interaction.options.getUser('user') || interaction.user;
      const player = getOrCreatePlayer(guildId, teamSize, user.id, user.username);
      const tier = getDivisionTier(player.division);
      const config = getDivision(guildId, teamSize, player.division);

      const embed = new EmbedBuilder()
        .setColor(0x2979ff)
        .setTitle(`${tier.emoji} ${user.username} — ${tier.name} (${formatTeamSize(teamSize)})`)
        .setDescription(
          player.placed
            ? `**${player.mmr} MMR**`
            : `**${player.mmr} MMR**\n\n⚠️ Not yet placed. An admin should run \`/division place\` after reviewing their RL Tracker profile.`
        )
        .setTimestamp();

      if (config) {
        const notes: string[] = [];
        if (config.promote_at !== null) {
          notes.push(
            player.mmr >= config.promote_at
              ? `⬆️ In the promotion zone (needs ${config.promote_at} at season end)`
              : `${config.promote_at - player.mmr} MMR from the promotion zone`
          );
        }
        if (config.relegate_below !== null) {
          notes.push(
            player.mmr < config.relegate_below
              ? `⬇️ In the relegation zone (needs ${config.relegate_below} at season end)`
              : `${player.mmr - config.relegate_below + 1} MMR clear of relegation`
          );
        }
        if (notes.length > 0) {
          embed.addFields({ name: 'Season standing', value: notes.join('\n'), inline: false });
        }
      }

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    if (sub === 'place') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: '❌ You need Administrator permissions to place players.',
          ephemeral: true,
        });
        return;
      }

      const teamSize = getTeamSizeOption(interaction);
      const user = interaction.options.getUser('user', true);
      const division = interaction.options.getString('division', true);
      const keepMmr = interaction.options.getBoolean('keep-mmr') ?? false;

      getOrCreatePlayer(guildId, teamSize, user.id, user.username);
      const before = getPlayer(guildId, teamSize, user.id)!;

      let updated;
      try {
        updated = setPlayerDivision(guildId, teamSize, user.id, division, !keepMmr)!;
      } catch (err: any) {
        await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        return;
      }

      const tier = getDivisionTier(updated.division);
      const embed = new EmbedBuilder()
        .setColor(0x00e676)
        .setTitle(`${tier.emoji} Placed in ${tier.name} (${formatTeamSize(teamSize)})`)
        .addFields(
          { name: 'Player', value: `<@${user.id}>`, inline: true },
          { name: 'Division', value: `${before.division} → **${updated.division}**`, inline: true },
          {
            name: 'MMR',
            value: keepMmr ? `${updated.mmr} (kept)` : `${before.mmr} → **${updated.mmr}**`,
            inline: true,
          }
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      logger.info(
        `Guild ${guildId}: ${interaction.user.id} placed ${user.id} in ${formatTeamSize(teamSize)} division ${division} (keepMmr=${keepMmr}).`
      );
      return;
    }

    if (sub === 'configure') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: '❌ You need Administrator permissions to configure divisions.',
          ephemeral: true,
        });
        return;
      }

      const teamSize = getTeamSizeOption(interaction);
      const division = interaction.options.getString('division', true);
      if (!getDivision(guildId, teamSize, division)) {
        await interaction.reply({
          content: `❌ Division ${division} is not configured for ${formatTeamSize(teamSize)} on this server.`,
          ephemeral: true,
        });
        return;
      }

      const updates: Record<string, unknown> = {};
      const channel = interaction.options.getChannel('queue-channel');
      const role = interaction.options.getRole('role');
      const defaultMmr = interaction.options.getInteger('default-mmr');
      const promoteAt = interaction.options.getInteger('promote-at');
      const relegateBelow = interaction.options.getInteger('relegate-below');

      if (channel) updates.queue_channel_id = channel.id;
      if (role) updates.role_id = role.id;
      if (defaultMmr !== null) updates.default_mmr = defaultMmr;
      if (promoteAt !== null) updates.promote_at = promoteAt;
      if (relegateBelow !== null) updates.relegate_below = relegateBelow;

      if (Object.keys(updates).length === 0) {
        await interaction.reply({
          content: 'ℹ️ Nothing to change — pass at least one option.',
          ephemeral: true,
        });
        return;
      }

      updateDivision(guildId, teamSize, division, updates as any);
      const after = getDivision(guildId, teamSize, division)!;
      const tier = getDivisionTier(division);

      const embed = new EmbedBuilder()
        .setColor(0x2979ff)
        .setTitle(`${tier.emoji} ${after.display_name} — ${formatTeamSize(teamSize)} updated`)
        .setDescription(
          [
            `Season start: **${after.default_mmr} MMR**`,
            `Promotes at: ${after.promote_at !== null ? `**${after.promote_at}**` : '—'}`,
            `Relegates below: ${after.relegate_below !== null ? `**${after.relegate_below}**` : '—'}`,
            `Queue: ${after.queue_channel_id ? `<#${after.queue_channel_id}>` : '*not set*'}`,
            `Role: ${after.role_id ? `<@&${after.role_id}>` : '*not set*'}`,
          ].join('\n')
        )
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }
  },
};
