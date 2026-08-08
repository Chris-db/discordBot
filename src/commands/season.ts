import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
} from 'discord.js';
import {
  getActiveSeason,
  getSeasonHistory,
  getSeasonSnapshots,
  getTotalPlayersCount,
  getDivisions,
} from '../database/queries';
import db from '../database/db';
import { endSeason } from '../services/seasonService';
import { getDivisionTier } from '../services/mmrService';
import { SUPPORTED_TEAM_SIZES } from '../database/migrations';
import { formatTeamSize } from '../ui/teamSize';
import { logger } from '../utils/logger';

export const seasonCommand = {
  data: new SlashCommandBuilder()
    .setName('season')
    .setDescription('View or manage competitive seasons')
    .addSubcommand(sub =>
      sub.setName('info').setDescription('Show the current season and how far into it you are')
    )
    .addSubcommand(sub =>
      sub.setName('history').setDescription('List past seasons and their final standings')
    )
    .addSubcommand(sub =>
      sub
        .setName('end')
        .setDescription('End the season: promote, relegate, and reset MMR (Admin)')
        .addStringOption(opt =>
          opt
            .setName('confirm')
            .setDescription('Type the exact season name to confirm this irreversible reset')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('next-name').setDescription('Name for the new season').setRequired(false)
        )
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    if (sub === 'info') {
      const season = getActiveSeason(guildId);
      if (!season) {
        await interaction.reply({ content: '❌ No active season for this server.', ephemeral: true });
        return;
      }

      const matchCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM matches
             WHERE guild_id = ? AND state = 'COMPLETED' AND created_at >= ?`
          )
          .get(guildId, season.started_at) as { n: number }
      ).n;

      // One season spans every size, so the breakdown does too.
      const breakdown = SUPPORTED_TEAM_SIZES.flatMap(size => {
        const divisions = getDivisions(guildId, size).filter(
          d => getTotalPlayersCount(guildId, size, d.division) > 0
        );
        return divisions.map(d => {
          const tier = getDivisionTier(d.division);
          const count = getTotalPlayersCount(guildId, size, d.division);
          return `${tier.emoji} **${d.display_name}** ${formatTeamSize(size)} — ${count} players`;
        });
      }).join('\n');

      const startedUnix = Math.floor(new Date(season.started_at).getTime() / 1000);
      const embed = new EmbedBuilder()
        .setColor(0x2979ff)
        .setTitle(`📅 ${season.name}`)
        .setDescription(`Started <t:${startedUnix}:R> • **${matchCount}** matches played`)
        .addFields({ name: 'Divisions', value: breakdown || 'No divisions configured', inline: false })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'history') {
      const seasons = getSeasonHistory(guildId).filter(s => !s.is_active);
      if (seasons.length === 0) {
        await interaction.reply({
          content: 'ℹ️ No completed seasons yet. The first one is still running.',
          ephemeral: true,
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0xffb300)
        .setTitle('📚 Past Seasons')
        .setTimestamp();

      for (const season of seasons.slice(0, 5)) {
        // Top of the highest division is the closest thing to an overall champion --
        // now one per size, since each is a separate ladder.
        const snaps = getSeasonSnapshots(season.season_id);
        const topByDivision = SUPPORTED_TEAM_SIZES.flatMap(size =>
          getDivisions(guildId, size)
            .slice()
            .reverse()
            .map(d => {
              const winner = snaps.find(
                s => s.team_size === size && s.division === d.division && s.final_rank === 1
              );
              if (!winner) return null;
              return `${getDivisionTier(d.division).emoji} ${formatTeamSize(size)} — <@${winner.discord_id}> (${winner.final_mmr})`;
            })
        )
          .filter(Boolean)
          .join('\n');

        const ended = season.ended_at
          ? `<t:${Math.floor(new Date(season.ended_at).getTime() / 1000)}:D>`
          : 'unknown';
        embed.addFields({
          name: `${season.name} — ended ${ended}`,
          value: topByDivision || 'No standings recorded',
          inline: false,
        });
      }

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'end') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: '❌ You need Administrator permissions to end a season.',
          ephemeral: true,
        });
        return;
      }

      const season = getActiveSeason(guildId);
      if (!season) {
        await interaction.reply({ content: '❌ No active season to end.', ephemeral: true });
        return;
      }

      // Ending a season rewrites every player's MMR and cannot be undone from inside the
      // bot -- the only way back is the nightly backup. Make the admin type the name.
      const confirm = interaction.options.getString('confirm', true);
      if (confirm !== season.name) {
        await interaction.reply({
          content:
            `❌ Confirmation did not match. To end **${season.name}**, re-run with ` +
            `\`confirm: ${season.name}\`.\n` +
            `This resets every player's MMR to their division default and cannot be undone.`,
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();

      const nextName = interaction.options.getString('next-name') || undefined;
      let result;
      try {
        result = endSeason(guildId, nextName);
      } catch (err: any) {
        logger.error(`Failed to end season for guild ${guildId}:`, err);
        await interaction.editReply({ content: `❌ ${err.message || 'Could not end the season.'}` });
        return;
      }

      const promoted = result.results.filter(r => r.outcome === 'PROMOTED');
      const relegated = result.results.filter(r => r.outcome === 'RELEGATED');

      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle(`🏁 ${result.endedSeason.name} has ended`)
        .setDescription(
          `**${result.results.length}** ladder placements reset • **${result.newSeason.name}** is now live.`
        )
        .setTimestamp();

      const championLines = SUPPORTED_TEAM_SIZES.flatMap(size =>
        getDivisions(guildId, size)
          .slice()
          .reverse()
          .map(d => {
            const champ = result.results.find(
              r => r.teamSize === size && r.fromDivision === d.division && r.finalRank === 1
            );
            if (!champ) return null;
            return `${getDivisionTier(d.division).emoji} **${d.display_name} ${formatTeamSize(size)}:** <@${champ.discord_id}> (${champ.finalMmr})`;
          })
      )
        .filter(Boolean)
        .join('\n');
      if (championLines) {
        embed.addFields({ name: '🏆 Division Champions', value: championLines, inline: false });
      }

      if (promoted.length > 0) {
        embed.addFields({
          name: `⬆️ Promoted (${promoted.length})`,
          value:
            promoted
              .slice(0, 10)
              .map(r => `<@${r.discord_id}> ${r.fromDivision} → **${r.toDivision}**`)
              .join('\n') + (promoted.length > 10 ? `\n…and ${promoted.length - 10} more` : ''),
          inline: false,
        });
      }
      if (relegated.length > 0) {
        embed.addFields({
          name: `⬇️ Relegated (${relegated.length})`,
          value:
            relegated
              .slice(0, 10)
              .map(r => `<@${r.discord_id}> ${r.fromDivision} → **${r.toDivision}**`)
              .join('\n') + (relegated.length > 10 ? `\n…and ${relegated.length - 10} more` : ''),
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed] });
      return;
    }
  },
};
