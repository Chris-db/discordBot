import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
} from 'discord.js';
import {
  getActiveMatches,
  getMatchByNumber,
  getMatchByTextChannel,
  cancelAllActiveMatches,
  updateMatch,
} from '../database/queries';
import type { Match } from '../database/queries';
import { formatTeamSize } from '../ui/teamSize';
import { forceReportMatch, cancelMatch, cleanupMatch } from '../services/matchService';
import { autoDeleteReply } from '../utils/autoDelete';
import { RL_COLORS } from '../ui/embeds';

const NO_MATCH_HERE =
  '❌ No match in this channel — run this inside a #match channel, or pass `match`.';

/**
 * The match an admin means: the one they named, else the one whose channel they are in.
 *
 * This replaced the Mod Override button, which sat on every match card. Standing in the
 * match channel and typing the command is the same gesture as clicking the button, as
 * long as nobody has to go and look up the id first.
 *
 * The number an admin types is the per-server one they see everywhere (#match-12), and
 * it is resolved inside their own guild -- so it cannot name another server's match.
 * Returns `null` when a number was given but matches nothing.
 */
function resolveMatch(interaction: ChatInputCommandInteraction): Match | undefined | null {
  const given = interaction.options.getInteger('match');
  if (given !== null) return getMatchByNumber(interaction.guildId!, given) ?? null;
  return getMatchByTextChannel(interaction.channelId);
}

function noSuchMatch(interaction: ChatInputCommandInteraction): string {
  return `❌ Match #${interaction.options.getInteger('match')} does not exist in this server.`;
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
          opt.setName('match').setDescription('Match number (the N in #match-N); defaults to the match in this channel').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('cancel')
        .setDescription('Force cancel an active match')
        .addIntegerOption(opt =>
          opt.setName('match').setDescription('Match number (the N in #match-N); defaults to the match in this channel').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('cleanup')
        .setDescription('Clean up temporary match text and voice channels (Admin/Mod)')
        .addIntegerOption(opt =>
          opt.setName('match').setDescription('Match number (the N in #match-N) to clean up specifically').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('cancel-all')
        .setDescription('Instantly cancel all active/stuck matches in the database (Admin/Mod)')
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    // The list is read, not glanced at -- an admin is copying a match id out of it. The
    // one-line confirmations can go after a few seconds as before.
    autoDeleteReply(interaction, subcommand === 'list' ? 120_000 : 6000);

    const guildId = interaction.guildId!;
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);

    if (subcommand === 'list') {
      const active = getActiveMatches(guildId);
      if (active.length === 0) {
        return interaction.reply({
          content: 'ℹ️ **No active matches are currently running.**',
          flags: MessageFlags.Ephemeral,
        });
      }

      const embed = new EmbedBuilder()
        .setTitle('🎮 ACTIVE 6MANS MATCHES')
        .setColor(RL_COLORS.BLUE)
        .setDescription(
          // Written to be acted on from an admin channel: the id for /match report or
          // /match cancel, the state, and a link to the match's own channel -- it used
          // to link the queue channel, which is not where the match is.
          active
            .map(m => {
              const blueMentions = m.blue_team.map(id => `<@${id}>`).join(', ');
              const orangeMentions = m.orange_team.map(id => `<@${id}>`).join(', ');
              const where = m.text_channel_id ? `<#${m.text_channel_id}>` : `queue <#${m.channel_id}>`;
              const ladder = `${formatTeamSize(m.team_size)}${m.division ? ` · Rank ${m.division}` : ''}`;
              const since = m.started_at
                ? ` · started <t:${Math.floor(new Date(m.started_at).getTime() / 1000)}:R>`
                : '';
              return (
                `**Match #${m.match_number}** · ${m.state.replace('_', ' ')} · ${ladder} · ${where}${since}\n` +
                `🔵 ${blueMentions || '—'}\n🟠 ${orangeMentions || '—'}\n`
              );
            })
            .join('\n')
        )
        .setFooter({ text: '/match report · /match cancel — both take the match number from anywhere' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'report') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to force-report matches.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const match = resolveMatch(interaction);
      if (match === undefined) {
        return interaction.reply({ content: NO_MATCH_HERE, flags: MessageFlags.Ephemeral });
      }
      if (match === null) {
        return interaction.reply({ content: noSuchMatch(interaction), flags: MessageFlags.Ephemeral });
      }
      const winner = interaction.options.getString('winner', true) as 'BLUE' | 'ORANGE';

      // Completing a match does a lot of Discord I/O (result image, channel sends, VC
      // teardown) — well past the 3s interaction window.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await forceReportMatch(interaction.client, match.match_id, winner);
      return interaction.editReply({
        content: res.success ? `✅ ${res.message}` : `❌ ${res.message}`,
      });
    }

    if (subcommand === 'cancel') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to cancel matches.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const match = resolveMatch(interaction);
      if (match === undefined) {
        return interaction.reply({ content: NO_MATCH_HERE, flags: MessageFlags.Ephemeral });
      }
      if (match === null) {
        return interaction.reply({ content: noSuchMatch(interaction), flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await cancelMatch(interaction.client, match.match_id, interaction.user.tag);
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
          flags: MessageFlags.Ephemeral,
        });
      }

      const number = interaction.options.getInteger('match');
      if (number !== null) {
        const match = getMatchByNumber(guildId, number);
        if (!match) {
          return interaction.reply({ content: noSuchMatch(interaction), flags: MessageFlags.Ephemeral });
        }
        const { cancelled } = await cleanupMatch(interaction.client, match.match_id);
        return interaction.reply({
          content: cancelled
            ? `✅ Cleaned up temporary channels and cancelled DB record for Match #${match.match_number}.`
            : `✅ Cleaned up temporary channels for Match #${match.match_number}. It had already ended, so its result is unchanged.`,
          flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    if (subcommand === 'cancel-all') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to cancel all matches.',
          flags: MessageFlags.Ephemeral,
        });
      }
      const cancelled = cancelAllActiveMatches(guildId);
      return interaction.reply({
        content: `✅ Successfully cancelled **${cancelled}** active/stuck match(es) in the database.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
