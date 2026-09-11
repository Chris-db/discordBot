import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { submitFeedback, FEEDBACK_MIN_LENGTH, FEEDBACK_MAX_LENGTH } from '../services/feedbackService';

/**
 * `/feedback <message>` -- a bug report or suggestion, filed straight to the bot's tracker.
 * Ephemeral both ways: the channel does not see it, and the reply is only to the sender.
 */
export const feedbackCommand = {
  data: new SlashCommandBuilder()
    .setName('feedback')
    .setDescription('Send a bug report or suggestion to whoever maintains the bot')
    .addStringOption(o =>
      o
        .setName('message')
        .setDescription('What happened, or what you would like changed')
        .setRequired(true)
        .setMinLength(FEEDBACK_MIN_LENGTH)
        .setMaxLength(FEEDBACK_MAX_LENGTH)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.channel;
    const result = await submitFeedback({
      userId: interaction.user.id,
      username: interaction.user.username,
      guildId: interaction.guildId,
      guildName: interaction.guild?.name ?? 'DM',
      channelName: channel && 'name' in channel && channel.name ? channel.name : 'unknown',
      text: interaction.options.getString('message', true),
    });

    switch (result.kind) {
      case 'filed':
        await interaction.editReply(`✅ Thanks — logged as #${result.issueNumber}. Someone will look at it.`);
        break;
      case 'rate-limited':
        await interaction.editReply(`⏳ You've sent a few already — try again in about ${result.retryAfterMinutes} min.`);
        break;
      case 'not-configured':
        await interaction.editReply('📝 Noted in the bot log. (Feedback tracking is not switched on for this bot yet.)');
        break;
      case 'failed':
        await interaction.editReply('❌ Could not send that right now. Please try again in a bit.');
        break;
    }
  },
};
