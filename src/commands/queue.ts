import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  TextChannel,
  MessageFlags,
} from 'discord.js';
import {
  refreshQueuePanel,
  startVotingPhase,
  startReadyCheckPhase,
  fillQueueWithBots,
  forcePopQueue,
} from '../services/queueService';
import { resolveTeamSize, registerQueueChannel, announceQueueOpened } from '../services/queuePanel';
import { logger } from '../utils/logger';
import {
  getQueue,
  saveQueue,
  getPlayersByIds,
  getOrCreatePlayer,
  getDivisionByChannel,
  getMatchByTextChannel,
  getLowestDivision,
  Player,
} from '../database/queries';
import { getQueuePanelButtons } from '../ui/buttons';
import { TEAM_SIZE_CHOICES, formatTeamSize } from '../ui/teamSize';
import { autoDeleteReply } from '../utils/autoDelete';
import { ensureGuildDefaults } from '../services/guildSetup';

const NO_PANEL_HERE = '❌ There is no queue panel in this channel. Run `/queue panel` in the queue channel.';

export const queueCommand = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Manage the Rocket League 6mans Queue')
    .addSubcommand(sub =>
      sub
        .setName('panel')
        .setDescription('Deploy an interactive Queue Panel in this channel (Admin/Mod)')
        .addIntegerOption(opt =>
          opt
            .setName('size')
            .setDescription('Team size this channel queues at (defaults to its current setting, or 3v3)')
            .setRequired(false)
            .addChoices(...TEAM_SIZE_CHOICES)
        )
        .addStringOption(opt =>
          opt
            .setName('division')
            .setDescription('Division ladder this channel feeds (defaults to the lowest)')
            .setRequired(false)
            .addChoices(
              { name: 'Rank C', value: 'C' },
              { name: 'Rank B', value: 'B' },
              { name: 'Rank A', value: 'A' },
              { name: 'Rank X', value: 'X' },
              { name: 'Rank S', value: 'S' }
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('status')
        .setDescription('Check the current queue status and waiting players')
    )
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Manually add a player to the queue (Admin/Mod)')
        .addUserOption(opt =>
          opt.setName('user').setDescription('The user to add').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Manually remove a player from the queue (Admin/Mod)')
        .addUserOption(opt =>
          opt.setName('user').setDescription('The user to remove').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('clear')
        .setDescription('Clear all players from the queue (Admin/Mod)')
    )
    .addSubcommand(sub =>
      sub
        .setName('fill-bots')
        .setDescription('Fill remaining queue slots with simulated AI bot players for testing (Admin/Mod)')
    )
    .addSubcommand(sub =>
      sub
        .setName('force-pop')
        .setDescription('Force pop the queue immediately (Admin/Mod)')
        .addStringOption(opt =>
          opt
            .setName('mode')
            .setDescription('Draft mode to force')
            .addChoices(
              { name: 'Balanced MMR', value: 'balanced' },
              { name: 'Captains Draft', value: 'captains' },
              { name: 'Random Teams', value: 'random' }
            )
        )
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    autoDeleteReply(interaction, 15000);
    const subcommand = interaction.options.getSubcommand();
    const channelId = interaction.channelId;
    const guildId = interaction.guildId!;

    // Permission check for admin/mod commands
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);

    if (subcommand === 'panel') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to deploy a Queue Panel.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Belt and braces for a guild that somehow missed the boot-time seed.
      ensureGuildDefaults(guildId);

      const requestedSize = interaction.options.getInteger('size');
      const requestedDivision = interaction.options.getString('division');

      // Deploying a panel registers the channel, every time. The division row that owns a
      // channel is the single source of truth for "how big is this queue" and, since the
      // #general incident, for "does this channel have a panel at all" -- the message
      // listener and the boot sweep both read it. With no size or division given, the
      // channel keeps its current registration or takes the lowest division.
      const size = requestedSize ?? resolveTeamSize(guildId, channelId);
      const division =
        requestedDivision ||
        getDivisionByChannel(guildId, channelId)?.division ||
        getLowestDivision(guildId, size)?.division;

      if (!division) {
        return interaction.editReply({
          content: `❌ No divisions are configured for ${formatTeamSize(size)} on this server.`,
        });
      }

      const existing = getQueue(channelId);
      if (existing && existing.team_size !== size) {
        if (existing.state !== 'WAITING') {
          return interaction.editReply({
            content: '❌ This queue has already popped — wait for it to finish before changing its size.',
          });
        }
        if (existing.player_ids.length > 0) {
          return interaction.editReply({
            content: `❌ ${existing.player_ids.length} player(s) are already queued here. Run \`/queue clear\` first.`,
          });
        }
      }

      const queue = await registerQueueChannel(interaction.client, guildId, channelId, size, division);

      return interaction.editReply({
        content: `✅ **${formatTeamSize(queue.team_size)}** Queue Panel deployed — Rank ${division}.`,
      });
    }

    if (subcommand === 'status') {
      const queue = getQueue(channelId);
      if (!queue || queue.player_ids.length === 0) {
        return interaction.reply({
          content: 'ℹ️ **The queue is currently empty.** Click **Join Queue** on the panel to start!',
          flags: MessageFlags.Ephemeral,
        });
      }

      const players = getPlayersByIds(queue.guild_id, queue.team_size, queue.player_ids);
      const mentions = players.map((p: Player, idx: number) => `**${idx + 1}.** <@${p.discord_id}> (\`${p.mmr} MMR\`)`).join('\n');
      return interaction.reply({
        content: `🚀 **Current ${formatTeamSize(queue.team_size)} Queue (${players.length}/${queue.team_size * 2}):**\n\n${mentions}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'add') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to manually add players.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const user = interaction.options.getUser('user', true);
      // Only a channel with a panel has a queue. Creating the row here is how a stray
      // panel ended up in #general.
      const queue = getQueue(channelId);
      if (!queue) {
        return interaction.reply({ content: NO_PANEL_HERE, flags: MessageFlags.Ephemeral });
      }

      if (queue.player_ids.includes(user.id)) {
        return interaction.reply({
          content: `❌ <@${user.id}> is already in the queue.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      getOrCreatePlayer(guildId, queue.team_size, user.id, user.username);
      const wasEmpty = queue.player_ids.length === 0;
      queue.player_ids.push(user.id);
      queue.player_join_times = queue.player_join_times || {};
      queue.player_join_times[user.id] = Date.now();
      saveQueue(queue);

      const capacity = queue.team_size * 2;
      // An admin seating the first player opens the queue just as a click would.
      if (wasEmpty) {
        await announceQueueOpened(interaction.client, channelId, guildId, user, 1, capacity).catch(err =>
          logger.warn(`Queue-open ping failed in ${channelId}:`, err)
        );
      }

      await refreshQueuePanel(interaction.client, channelId);

      await interaction.reply({
        content: `✅ Added <@${user.id}> to the queue (${queue.player_ids.length}/${capacity}).`,
        flags: MessageFlags.Ephemeral,
      });

      if (queue.player_ids.length === capacity) {
        await startReadyCheckPhase(interaction.client, channelId, guildId, queue);
      }
      return;
    }

    if (subcommand === 'remove') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to manually remove players.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const user = interaction.options.getUser('user', true);
      const queue = getQueue(channelId);
      if (!queue || !queue.player_ids.includes(user.id)) {
        return interaction.reply({
          content: `❌ <@${user.id}> is not in the queue.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      queue.player_ids = queue.player_ids.filter((id: string) => id !== user.id);
      if (queue.player_join_times) {
        delete queue.player_join_times[user.id];
      }
      saveQueue(queue);

      await refreshQueuePanel(interaction.client, channelId);
      return interaction.reply({
        content: `✅ Removed <@${user.id}> from the queue (${queue.player_ids.length}/${queue.team_size * 2}).`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'clear') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to clear the queue.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // Inside #match-N the queue row is the lobby, not a waiting list. Wiping it here
      // would leave the match live with no lobby behind it -- players locked out, channels
      // never torn down. That is what /match cancel is for.
      const liveMatch = getMatchByTextChannel(channelId);
      if (liveMatch) {
        return interaction.reply({
          content: `❌ This is the channel for Match #${liveMatch.match_number}. Use \`/match cancel\` to end it.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // Only a channel with a panel has a queue. Creating the row here is how a stray
      // panel ended up in #general.
      const queue = getQueue(channelId);
      if (!queue) {
        return interaction.reply({ content: NO_PANEL_HERE, flags: MessageFlags.Ephemeral });
      }
      if (queue.ready_check_vc_id) {
        const vc = await interaction.guild?.channels.fetch(queue.ready_check_vc_id).catch(() => null);
        if (vc) {
          await vc.delete('Queue cleared by admin').catch(() => null);
        }
      }
      queue.player_ids = [];
      queue.player_join_times = {};
      queue.state = 'WAITING';
      queue.vote_counts = {};
      queue.draft_state = undefined;
      queue.captain_vote_state = undefined;
      queue.team_vote_state = undefined;
      queue.ready_check_vc_id = undefined;
      saveQueue(queue);

      await refreshQueuePanel(interaction.client, channelId);
      return interaction.reply({
        content: '🧹 **Queue has been cleared.**',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'fill-bots') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to fill the queue with test bots.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await fillQueueWithBots(interaction.client, channelId, guildId);
      await interaction.editReply({ content: res.message }).catch(() => null);
      return;
    }

    if (subcommand === 'force-pop') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to force-pop the queue.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const mode = interaction.options.getString('mode') as 'balanced' | 'captains' | 'random' | undefined;
      const res = await forcePopQueue(interaction.client, channelId, guildId, mode);
      await interaction.editReply({ content: res.message }).catch(() => null);
      return;
    }
  },
};
