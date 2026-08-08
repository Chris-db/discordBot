import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import {
  getOrInitQueue,
  refreshQueuePanel,
  startVotingPhase,
  startReadyCheckPhase,
  fillQueueWithBots,
  forcePopQueue,
} from '../services/queueService';
import { resolveTeamSize } from '../services/queuePanel';
import {
  getQueue,
  saveQueue,
  getPlayersByIds,
  getOrCreatePlayer,
  getDivisionByChannel,
  getLowestDivision,
  updateDivision,
  Player,
} from '../database/queries';
import { buildQueuePanelEmbed } from '../ui/embeds';
import { getQueuePanelButtons } from '../ui/buttons';
import { TEAM_SIZE_CHOICES, formatTeamSize } from '../ui/teamSize';
import { autoDeleteReply } from '../utils/autoDelete';

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
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });

      const requestedSize = interaction.options.getInteger('size');
      const requestedDivision = interaction.options.getString('division');

      // Registering the channel is what sets its size: the division row that owns a
      // channel is the single source of truth for "how big is this queue".
      if (requestedSize || requestedDivision) {
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

        updateDivision(guildId, size, division, { queue_channel_id: channelId });

        // The queue row caches the size, so an existing empty row has to be told.
        if (existing) {
          existing.team_size = size;
          saveQueue(existing);
        }
      }

      getOrInitQueue(channelId, guildId);
      const queue = getQueue(channelId)!;
      await refreshQueuePanel(interaction.client, channelId);

      return interaction.editReply({
        content: `✅ **${formatTeamSize(queue.team_size)}** Queue Panel deployed!`,
      });
    }

    if (subcommand === 'status') {
      const queue = getQueue(channelId);
      if (!queue || queue.player_ids.length === 0) {
        return interaction.reply({
          content: 'ℹ️ **The queue is currently empty.** Click **Join Queue** on the panel to start!',
          ephemeral: true,
        });
      }

      const players = getPlayersByIds(queue.guild_id, queue.team_size, queue.player_ids);
      const mentions = players.map((p: Player, idx: number) => `**${idx + 1}.** <@${p.discord_id}> (\`${p.mmr} MMR\`)`).join('\n');
      return interaction.reply({
        content: `🚀 **Current ${formatTeamSize(queue.team_size)} Queue (${players.length}/${queue.team_size * 2}):**\n\n${mentions}`,
        ephemeral: true,
      });
    }

    if (subcommand === 'add') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to manually add players.',
          ephemeral: true,
        });
      }

      const user = interaction.options.getUser('user', true);
      const queue = getOrInitQueue(channelId, guildId);

      if (queue.player_ids.includes(user.id)) {
        return interaction.reply({
          content: `❌ <@${user.id}> is already in the queue.`,
          ephemeral: true,
        });
      }

      getOrCreatePlayer(guildId, queue.team_size, user.id, user.username);
      queue.player_ids.push(user.id);
      queue.player_join_times = queue.player_join_times || {};
      queue.player_join_times[user.id] = Date.now();
      saveQueue(queue);

      await refreshQueuePanel(interaction.client, channelId);

      const capacity = queue.team_size * 2;
      await interaction.reply({
        content: `✅ Added <@${user.id}> to the queue (${queue.player_ids.length}/${capacity}).`,
        ephemeral: true,
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
          ephemeral: true,
        });
      }

      const user = interaction.options.getUser('user', true);
      const queue = getQueue(channelId);
      if (!queue || !queue.player_ids.includes(user.id)) {
        return interaction.reply({
          content: `❌ <@${user.id}> is not in the queue.`,
          ephemeral: true,
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
        ephemeral: true,
      });
    }

    if (subcommand === 'clear') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to clear the queue.',
          ephemeral: true,
        });
      }

      const queue = getOrInitQueue(channelId, guildId);
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
      queue.ready_check_vc_id = undefined;
      saveQueue(queue);

      await refreshQueuePanel(interaction.client, channelId);
      return interaction.reply({
        content: '🧹 **Queue has been cleared.**',
        ephemeral: true,
      });
    }

    if (subcommand === 'fill-bots') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to fill the queue with test bots.',
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });
      const res = await fillQueueWithBots(interaction.client, channelId, guildId);
      await interaction.editReply({ content: res.message }).catch(() => null);
      return;
    }

    if (subcommand === 'force-pop') {
      if (!isAdmin) {
        return interaction.reply({
          content: '❌ You need **Manage Channels** permission to force-pop the queue.',
          ephemeral: true,
        });
      }

      await interaction.deferReply({ ephemeral: true });
      const mode = interaction.options.getString('mode') as 'balanced' | 'captains' | 'random' | undefined;
      const res = await forcePopQueue(interaction.client, channelId, guildId, mode);
      await interaction.editReply({ content: res.message }).catch(() => null);
      return;
    }
  },
};
