import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { runSetup, missingBotPermissions, DivisionPreset, DEFAULT_LADDER_NAME } from '../services/setupService';
import { TEAM_SIZE_CHOICES, formatTeamSize } from '../ui/teamSize';
import { DEFAULT_TEAM_SIZE } from '../database/migrations';
import { RL_COLORS } from '../ui/embeds';
import { logger } from '../utils/logger';

/**
 * `/setup` -- build a server's queue channels in one go. Admin only (Manage Server), and
 * safe to run again: it reuses anything that already exists.
 */
export const setupCommand = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Create the rank categories, queue channels and (optionally) roles for this server (Admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(opt =>
      opt
        .setName('divisions')
        .setDescription('How many rank divisions to set up')
        .setRequired(false)
        .addChoices(
          { name: 'One ladder — everyone plays together (best for small servers)', value: 'one' },
          { name: 'Three — Rank C, B, A', value: 'three' },
          { name: 'All five — Rank C, B, A, X, S', value: 'all' }
        )
    )
    .addIntegerOption(opt =>
      opt
        .setName('size')
        .setDescription('Team size for these queues (defaults to 3v3; run again for another size)')
        .setRequired(false)
        .addChoices(...TEAM_SIZE_CHOICES)
    )
    .addStringOption(opt =>
      opt
        .setName('name')
        .setDescription(`One ladder only: what to call it on the panel, cards and sidebar (default: ${DEFAULT_LADDER_NAME})`)
        .setRequired(false)
        .setMinLength(2)
        .setMaxLength(24)
    )
    .addBooleanOption(opt =>
      opt
        .setName('roles')
        .setDescription('Also create a role per division and show each rank category only to its role (default: no)')
        .setRequired(false)
    )
    .addBooleanOption(opt =>
      opt
        .setName('feed')
        .setDescription('Also create a public #active-matches channel for live match cards (default: yes)')
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      return interaction.reply({ content: '❌ Run this inside a server.', flags: MessageFlags.Ephemeral });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: '❌ You need **Manage Server** permission to run setup.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const opts = {
      preset: (interaction.options.getString('divisions') ?? 'one') as DivisionPreset,
      teamSize: interaction.options.getInteger('size') ?? DEFAULT_TEAM_SIZE,
      roles: interaction.options.getBoolean('roles') ?? false,
      feed: interaction.options.getBoolean('feed') ?? true,
      name: interaction.options.getString('name') ?? undefined,
    };

    const missing = missingBotPermissions(interaction.guild, opts.roles);
    if (missing.length > 0) {
      return interaction.reply({
        content:
          `❌ The bot is missing permissions it needs for setup: **${missing.join(', ')}**.\n` +
          'Give its role those permissions (Server Settings → Roles) and run `/setup` again.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // Creating a dozen channels and roles takes longer than Discord's 3-second window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const report = await runSetup(interaction.client, interaction.guild, opts);

      const embed = new EmbedBuilder()
        .setTitle(`✅ ${formatTeamSize(opts.teamSize)} setup done — ${report.created} created, ${report.reused} already there`)
        .setColor(RL_COLORS.ORANGE)
        .setDescription(report.lines.join('\n') || '*Nothing to do.*')
        .addFields({
          name: 'Next',
          value:
            '• Players click **Join Queue** on the panel in their rank channel.\n' +
            (opts.preset === 'one'
              ? '• One ladder — everyone starts at 1000 MMR, no placement needed.\n'
              : '• Place players with `/division place <user> <division>` (new players start in Rank C).\n') +
            (opts.roles ? '• Give each player their rank role so they can see their category.\n' : '') +
            '• `/help` explains the rest. Run `/setup` again any time; it only adds what is missing.',
        });
      if (report.warnings.length) {
        embed.addFields({ name: '⚠️ Warnings', value: report.warnings.join('\n').slice(0, 1000) });
      }
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('Error running /setup:', err);
      return interaction.editReply({
        content: `❌ Setup stopped part-way: ${err instanceof Error ? err.message : String(err)}\nWhatever was created is kept — fix the cause and run \`/setup\` again to finish.`,
      });
    }
  },
};
