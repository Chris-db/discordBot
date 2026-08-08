import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { Player } from '../database/queries';
import { getDivisionTier } from '../services/mmrService';

/**
 * Builds a Discord Select Menu for Captains to draft a teammate from the remaining player pool.
 */
export function getCaptainsDraftSelectMenu(
  remainingPlayers: Player[],
  pickNumber: number,
  turn: 'BLUE' | 'ORANGE',
  totalPicks: number
): ActionRowBuilder<StringSelectMenuBuilder> {
  const teamLabel = turn === 'BLUE' ? '🔵 Blue Captain' : '🟠 Orange Captain';

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('draft_select_player')
    .setPlaceholder(`${teamLabel}: Choose a teammate (Pick #${pickNumber} of ${totalPicks})...`)
    .addOptions(
      remainingPlayers.map(player => {
        const tier = getDivisionTier(player.division);
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${player.username} (${player.mmr} MMR)`)
          .setDescription(`Rank: ${tier.name} • W/L: ${player.wins}-${player.losses}`)
          .setValue(player.discord_id)
          .setEmoji(tier.emoji);
      })
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
}
