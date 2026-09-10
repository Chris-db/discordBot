import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  AttachmentBuilder,
} from 'discord.js';
import {
  getActiveMatches,
  getMatch,
  getMatchByTextChannel,
  cancelAllActiveMatches,
  updateMatch,
} from '../database/queries';
import { forceReportMatch, cancelMatch } from '../services/matchService';
import { deleteMatchChannels } from '../services/channelService';
import { autoDeleteReply } from '../utils/autoDelete';
import { RL_COLORS } from '../ui/embeds';

const NO_MATCH_HERE =
  '❌ No match in this channel — run this inside a #match channel, or pass `match_id`.';

/**
 * The match an admin means: the one they named, else the one whose channel they are in.
 *
 * This replaced the Mod Override button, which sat on every match card. Standing in the
 * match channel and typing the command is the same gesture as clicking the button, as
 * long as nobody has to go and look up the id first.
 */
function resolveMatchId(interaction: ChatInputCommandInteraction): number | undefined {
  const given = interaction.options.getInteger('match_id');
  if (given !== null) return given;
  return getMatchByTextChannel(interaction.channelId)?.match_id;
}

export const matchCommand = {
  data: new SlashCommandBuilder()
    .setName('match')
    .setDescription('Manage active 6mans matches (Admin/Mod)')
    // Discord hides the command from anyone without this permission, which is the only
    // way to make an admin control invisible to players -- message buttons cannot be.
    // The per-subcommand isAdmin checks below stay as the backstop for servers that
    // loosen this in Integrations settings.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('List all active matches in this server')
    )
    .addSubcommand(sub =>
      sub
        .setName('report')
        .setDescription('Force report a match winner')
        .addStringOption(opt =>
          opt
            .setName('winner')
            .setDescription('Winning team')
            .setRequired(true)
            .addChoices(
              { name: 'Team Blue 🔵', value: 'BLUE' },
              { name: 'Team Orange 🟠', value: 'ORANGE' }
            )
        )
        .addIntegerOption(opt =>
          opt.setName('match_id').setDescription('Defaults to the match in this channel').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('cancel')
        .setDescription('Force cancel an active match')
        .addIntegerOption(opt =>
          opt.setName('match_id').setDescription('Defaults to the match in this channel').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('cleanup')
        .setDescription('Clean up temporary match text and voice channels (Admin/Mod)')
        .addIntegerOption(opt =>
          opt.setName('match_id').setDescription('Optional match ID to clean up specifically').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('cancel-all')
        .setDescription('Instantly cancel all active/stuck matches in the database (Admin/Mod)')
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    autoDeleteReply(interaction, 6000);
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);

    if (subcommand === 'list') {
      const active = getActiveMatches(guildId);
      if (active.length === 0) {
        return interaction.reply({
          content: 'ℹ️ **No active matches are currently running.**',
          ephemeral: true,
        });
      }

      const embed = new EmbedBuilder()
        .setTitle('🎮 ACTIVE 6MANS MATCHES')
        .setColor(RL_COLORS.BLUE)
        .setDescription(
          active
            .map(m => {
              const blueMentions = m.blue_team.map(id => `<@${id}>`).join(', ');
              const orangeMentions = m.orange_team.map(id => `<@${id}>`).join(', ');
              return `**Match #${m.match_id}** (Channel: <#${m.channel_id}>)\n🔵 **Blue:** ${blueMentions}\n🟠 **Orange:** ${orangeMentions}\n`;
            })
            .join('\n---\n')
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (subcommand === 'report') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to force-report matches.',
          ephemeral: true,
        });
      }

      const matchId = resolveMatchId(interaction);
      if (matchId === undefined) {
        return interaction.reply({ content: NO_MATCH_HERE, ephemeral: true });
      }
      const winner = interaction.options.getString('winner', true) as 'BLUE' | 'ORANGE';

      // Completing a match does a lot of Discord I/O (result image, channel sends, VC
      // teardown) — well past the 3s interaction window.
      await interaction.deferReply({ ephemeral: true });
      const res = await forceReportMatch(interaction.client, matchId, winner);
      return interaction.editReply({
        content: res.success ? `✅ ${res.message}` : `❌ ${res.message}`,
      });
    }

    if (subcommand === 'cancel') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to cancel matches.',
          ephemeral: true,
        });
      }

      const matchId = resolveMatchId(interaction);
      if (matchId === undefined) {
        return interaction.reply({ content: NO_MATCH_HERE, ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });
      const res = await cancelMatch(interaction.client, matchId, interaction.user.tag);
      // cancelMatch already posts a public notice in the match channel — keep this one
      // terse so the admin doesn't see the same thing announced twice.
      return interaction.editReply({
        content: res.success ? `✅ Done.` : `❌ ${res.message}`,
      });
    }

    if (subcommand === 'cleanup') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to clean up match channels.',
          ephemeral: true,
        });
      }

      const matchId = interaction.options.getInteger('match_id');
      if (matchId) {
        await deleteMatchChannels(interaction.client, matchId);
        updateMatch(matchId, {
          state: 'CANCELLED',
          winner: 'NONE',
          completed_at: new Date().toISOString(),
        });
        return interaction.reply({
          content: `✅ Cleaned up temporary channels and cancelled DB record for Match #${matchId}.`,
          ephemeral: true,
        });
      } else {
        const guild = interaction.guild!;
        let orphanedDbCount = 0;
        const activeMatches = getActiveMatches(guildId);
        const activeIds = new Set<string>();

        for (const m of activeMatches) {
          let channelExists = false;
          if (m.text_channel_id) {
            const chan = await guild.channels.fetch(m.text_channel_id).catch(() => null);
            if (chan) {
              channelExists = true;
              activeIds.add(m.text_channel_id);
            }
          }
          if (m.blue_voice_id) activeIds.add(m.blue_voice_id);
          if (m.orange_voice_id) activeIds.add(m.orange_voice_id);

          if (!channelExists) {
            updateMatch(m.match_id, {
              state: 'CANCELLED',
              winner: 'NONE',
              completed_at: new Date().toISOString(),
            });
            orphanedDbCount++;
          }
        }

        let deletedCount = 0;
        const category = guild.channels.cache.find(
          c => c.name.toLowerCase() === '🎮 active 6mans matches'
        );
        if (category) {
          const children = guild.channels.cache.filter(c => c.parentId === category.id);
          for (const [id, chan] of children) {
            if (!activeIds.has(id)) {
              await chan.delete().catch(() => null);
              deletedCount++;
            }
          }
        }

        return interaction.reply({
          content: `✅ Cleaned up **${deletedCount}** orphaned Discord channel(s) and marked **${orphanedDbCount}** missing active match(es) as cancelled in DB.`,
          ephemeral: true,
        });
      }
    }

    if (subcommand === 'cancel-all') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to cancel all matches.',
          ephemeral: true,
        });
      }
      const cancelled = cancelAllActiveMatches(guildId);
      return interaction.reply({
        content: `✅ Successfully cancelled **${cancelled}** active/stuck match(es) in the database.`,
        ephemeral: true,
      });
    }
  },
};
