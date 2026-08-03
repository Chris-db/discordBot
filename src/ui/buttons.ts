import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

/**
 * ActionRow for the persistent Queue Panel: Join, Leave, Stats, Leaderboard.
 */
export function getQueuePanelButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('queue_join')
      .setLabel('Join Queue')
      .setEmoji('🚀')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('queue_leave')
      .setLabel('Leave Queue')
      .setEmoji('🚪')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('queue_stats')
      .setLabel('My Rank')
      .setEmoji('⚡')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('queue_leaderboard')
      .setLabel('Leaderboard')
      .setEmoji('🏆')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('queue_history')
      .setLabel('History')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * ActionRow for Voting on the Team Selection Mode.
 */
export function getModeVoteButtons(voteCounts: {
  captains: number;
  balanced: number;
  random: number;
}): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('vote_captains')
      .setLabel(`Captains Draft (${voteCounts.captains})`)
      .setEmoji('👑')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('vote_balanced')
      .setLabel(`Balanced MMR (${voteCounts.balanced})`)
      .setEmoji('⚖️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('vote_random')
      .setLabel(`Random Teams (${voteCounts.random})`)
      .setEmoji('🎲')
      .setStyle(ButtonStyle.Primary)
  );
}

/**
 * ActionRow for Voting on proposed Captains.
 */
export function getCaptainsVoteButtons(voteCounts: {
  yes: number;
  no: number;
}): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('captains_verify_yes')
      .setLabel(`Yes, Proceed (${voteCounts.yes})`)
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('captains_verify_no')
      .setLabel(`No, Randomize (${voteCounts.no})`)
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Danger)
  );
}

/**
 * ActionRow for Voting on proposed Random/Balanced Teams verification.
 */
export function getTeamsVoteButtons(
  voteCounts: {
    yes: number;
    no: number;
  },
  mode: 'random' | 'balanced' = 'random'
): ActionRowBuilder<ButtonBuilder> {
  // The re-roll stays in the voted mode, so the label has to match what the button does.
  const rerollLabel = mode === 'balanced' ? 'No, Next Split' : 'No, Randomize';
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('teams_verify_yes')
      .setLabel(`Yes, Proceed (${voteCounts.yes})`)
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('teams_verify_no')
      .setLabel(`${rerollLabel} (${voteCounts.no})`)
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Danger)
  );
}

/**
 * ActionRow for Active Match Actions: Report Blue, Report Orange, Cancel, Mod Override.
 */
export function getMatchActionButtons(matchId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`match_report_blue_${matchId}`)
      .setLabel('Report Blue Win')
      .setEmoji('🔵')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`match_report_orange_${matchId}`)
      .setLabel('Report Orange Win')
      .setEmoji('🟠')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`match_cancel_${matchId}`)
      .setLabel('Cancel Match')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`match_mod_override_${matchId}`)
      .setLabel('Mod Override')
      .setEmoji('🛠️')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Modal or button for Mod Override confirmation modal / buttons.
 */
export function getModOverrideButtons(matchId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`mod_force_blue_${matchId}`)
      .setLabel('Force Blue Win')
      .setEmoji('🔵')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`mod_force_orange_${matchId}`)
      .setLabel('Force Orange Win')
      .setEmoji('🟠')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`mod_force_cancel_${matchId}`)
      .setLabel('Force Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
  );
}

/**
 * ActionRow for Leaderboard pagination & interactions.
 */
export function getLeaderboardButtons(page: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`leaderboard_prev_${page}`)
      .setLabel('Prev')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`leaderboard_next_${page}`)
      .setLabel('Next')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId('leaderboard_my_rank')
      .setLabel('My Rank')
      .setEmoji('⚡')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`leaderboard_refresh_${page}`)
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * ActionRow for proposing Double or Nothing after match completion (60s timer).
 */
export function getGambleProposeButton(matchId: number, disabled: boolean = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`gamble_propose_${matchId}`)
      .setLabel('Double or Nothing (6/6 Required)')
      .setEmoji('🎰')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled)
  );
}

/**
 * ActionRow for voting on Double or Nothing (Agree / Decline).
 */
export function getGambleConsensusButtons(matchId: number, disabled: boolean = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`gamble_agree_${matchId}`)
      .setLabel('I Agree to Gamble')
      .setEmoji('🤝')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`gamble_decline_${matchId}`)
      .setLabel('Decline')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}
