import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import {
  createBan,
  getActiveBan,
  revokeBan,
  getActiveBansByGuild,
  getActiveMatchForPlayer,
} from '../database/queries';
import { removePlayerFromWaitingQueues } from '../services/queuePanel';
import { parseDbTimestamp } from '../utils/time';
import { logger } from '../utils/logger';

export function parseDurationToIso(duration: string): string | null {
  const d = duration.toLowerCase().trim();
  if (d === 'permanent' || d === 'perm' || d === '0') return null;
  // `mo` must be matched before `m`, and `m` means minutes -- it used to mean months, so
  // `/ban add 30m` (obviously "thirty minutes") banned the player for thirty months.
  const match = d.match(/^(\d+)(mo|[hdmw])$/);
  if (!match) {
    throw new Error(
      'Invalid duration format. Use e.g. 30m, 1h, 12h, 1d, 7d, 2w, 1mo, or permanent.'
    );
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (value <= 0) {
    throw new Error('Duration must be greater than zero.');
  }
  const now = new Date();
  if (unit === 'm') {
    now.setMinutes(now.getMinutes() + value);
  } else if (unit === 'h') {
    now.setHours(now.getHours() + value);
  } else if (unit === 'd') {
    now.setDate(now.getDate() + value);
  } else if (unit === 'w') {
    now.setDate(now.getDate() + value * 7);
  } else if (unit === 'mo') {
    now.setMonth(now.getMonth() + value);
  }
  return now.toISOString();
}

export const banCommand = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Manage 6mans queue bans and cooldowns')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Ban a player from joining queues')
        .addUserOption(opt =>
          opt.setName('user').setDescription('The user to ban').setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('duration')
            .setDescription('Duration: 30m, 1h, 12h, 1d, 7d, 2w, 1mo, or permanent')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('reason').setDescription('Reason for the ban').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Revoke an active queue ban for a player')
        .addUserOption(opt =>
          opt.setName('user').setDescription('The user to unban').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('check')
        .setDescription('Check if a player has an active queue ban')
        .addUserOption(opt =>
          opt.setName('user').setDescription('The user to check').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('List all currently active queue bans in this server')
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId || '';

    if (sub === 'add') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: '❌ You need Administrator permissions to ban players.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const user = interaction.options.getUser('user', true);
      const durationStr = interaction.options.getString('duration', true);
      const reason = interaction.options.getString('reason') || 'No reason provided';

      let expiresAt: string | null = null;
      try {
        expiresAt = parseDurationToIso(durationStr);
      } catch (err: any) {
        await interaction.reply({
          content: `❌ ${err.message || 'Invalid duration string.'}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const ban = createBan(guildId, user.id, interaction.user.id, reason, expiresAt);
      const expiryStr = ban.expires_at
        ? `<t:${Math.floor(new Date(ban.expires_at).getTime() / 1000)}:R>`
        : '**Permanent**';

      // A ban that leaves the player sitting in the queue they were banned from isn't a ban.
      const removedFrom = await removePlayerFromWaitingQueues(
        interaction.client,
        guildId,
        user.id
      );

      const embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('🚫 Player Banned from Queue')
        .addFields(
          { name: 'Player', value: `<@${user.id}> (${user.username})`, inline: true },
          { name: 'Banned By', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Expires', value: expiryStr, inline: true },
          { name: 'Reason', value: reason, inline: false }
        )
        .setTimestamp();

      if (removedFrom.length > 0) {
        embed.addFields({
          name: 'Removed From Queue',
          value: removedFrom.map(id => `<#${id}>`).join(', '),
          inline: false,
        });
      }

      const activeMatch = getActiveMatchForPlayer(guildId, user.id);
      if (activeMatch) {
        embed.addFields({
          name: '⚠️ Currently In A Match',
          value: `Still in Match #${activeMatch.match_number}. Run \`/match cancel match:${activeMatch.match_number}\` if they should be pulled out of it.`,
          inline: false,
        });
      }

      await interaction.reply({ embeds: [embed] });
      logger.info(`Player ${user.id} banned by ${interaction.user.id} until ${expiresAt || 'permanent'}. Reason: ${reason}`);
      return;
    }

    if (sub === 'remove') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: '❌ You need Administrator permissions to revoke bans.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const user = interaction.options.getUser('user', true);
      const success = revokeBan(guildId, user.id);

      if (success) {
        await interaction.reply({
          content: `✅ Successfully revoked active ban for <@${user.id}>.`,
        });
      } else {
        await interaction.reply({
          content: `⚠️ No active ban found for <@${user.id}>.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (sub === 'check') {
      const user = interaction.options.getUser('user', true);
      const activeBan = getActiveBan(guildId, user.id);

      if (activeBan) {
        const expiryStr = activeBan.expires_at
          ? `Expires: <t:${Math.floor(new Date(activeBan.expires_at).getTime() / 1000)}:R>`
          : '**Permanent**';

        const embed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle(`🚫 Active Ban for ${user.username}`)
          .addFields(
            { name: 'Player', value: `<@${user.id}>`, inline: true },
            { name: 'Banned By', value: `<@${activeBan.banned_by}>`, inline: true },
            { name: 'Expires', value: expiryStr, inline: true },
            { name: 'Reason', value: activeBan.reason, inline: false }
          )
          .setTimestamp(new Date(parseDbTimestamp(activeBan.created_at)));

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({
          content: `✅ <@${user.id}> does not have any active queue bans.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (sub === 'list') {
      const activeBans = getActiveBansByGuild(guildId);
      if (activeBans.length === 0) {
        await interaction.reply({
          content: '✅ There are currently no active queue bans in this server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const description = activeBans
        .slice(0, 15)
        .map((ban, i) => {
          const expiry = ban.expires_at
            ? `<t:${Math.floor(new Date(ban.expires_at).getTime() / 1000)}:R>`
            : 'Permanent';
          return `**${i + 1}.** <@${ban.discord_id}> — **Reason:** ${ban.reason} (${expiry})`;
        })
        .join('\n');

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(`📋 Active Queue Bans (${activeBans.length})`)
        .setDescription(description)
        .setTimestamp();

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
  },
};
