import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from 'discord.js';
import { RL_COLORS } from '../ui/embeds';

export const helpCommand = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Learn how Rocket League 6mans works and view available commands'),

  async execute(interaction: ChatInputCommandInteraction) {
    const embed = new EmbedBuilder()
      .setTitle('🚀 ROCKET LEAGUE 6MANS BOT — GUIDE & COMMANDS')
      .setColor(RL_COLORS.ORANGE)
      .setDescription(
        'Welcome to **Rocket League 6mans**! A competitive 3v3 pick-up game system with automated drafting, lobbies, voice channels, and ELO tracking.'
      )
      .addFields(
        {
          name: '🎮 HOW TO PLAY',
          value:
            '1. Click **Join Queue** on the interactive Queue Panel.\n' +
            '2. When 6 players join, vote for **Captains Draft**, **Balanced MMR**, or **Random Teams**.\n' +
            '3. The bot generates a private **Rocket League Lobby Name & Password** and creates temporary **Team Blue 🔵** and **Team Orange 🟠** voice channels.\n' +
            '4. After the match, click **Report Blue Win** or **Report Orange Win** to record the score and update ELO ratings.',
          inline: false,
        },
        {
          name: '💬 PLAYER COMMANDS',
          value:
            '`/queue status` — Check who is waiting in the queue\n' +
            '`/stats [user]` — View ELO rating, rank tier, wins, losses, and win rate\n' +
            '`/leaderboard` — View the top players on the server\n' +
            '`/history [user]` — View completed 6mans match history\n' +
            '`/match list` — View all active matches',
          inline: false,
        },
        {
          name: '🛠️ ADMIN / MOD COMMANDS',
          value:
            '`/queue panel` — Deploy the persistent interactive Queue Panel\n' +
            '`/queue add <user>` — Manually add a player to the queue\n' +
            '`/queue remove <user>` — Manually remove a player from the queue\n' +
            '`/queue clear` — Clear the current queue\n' +
            '`/queue fill-bots` — Fill queue with simulated bots for testing\n' +
            '`/queue force-pop [mode]` — Immediately pop queue with bots\n' +
            '`/match report <id> <winner>` — Force report a match winner\n' +
            '`/match cancel <id>` — Force cancel an active match\n' +
            '`/match cleanup [id]` — Clean up temporary match channels\n' +
            '`/set-mmr <user> <mmr>` — Adjust a player\'s ELO rating\n' +
            '`/ban add <user> <duration> [reason]` — Ban a player from queuing\n' +
            '`/ban remove <user>` — Remove an active queue ban\n' +
            '`/ban check <user>` — Check ban status for a player\n' +
            '`/ban list` — List all active queue bans',
          inline: false,
        },
        {
          name: '❓ FREQUENTLY ASKED QUESTIONS (FAQ)',
          value:
            '• **Where is my match channel?** A private text room (`#match-id`) and team voice channels appear inside your rank category.\n' +
            '• **Do I have to join Voice?** Yes, join your assigned `🔵 Team Blue` or `🟠 Team Orange` voice channel in the sidebar.\n' +
            '• **How do I report scores?** Click the win buttons inside `#match-id`. When confirmed, ELO updates automatically and rooms clean up after 30 seconds.',
          inline: false,
        },
        {
          name: '🏆 ELO RANK TIERS',
          value:
            '🚀 **Supersonic Legend**: 1600+ MMR\n' +
            '🔴 **Grand Champion**: 1400 - 1599 MMR\n' +
            '🟣 **Champion**: 1200 - 1399 MMR\n' +
            '🔵 **Diamond**: 1000 - 1199 MMR\n' +
            '⚪ **Platinum**: 800 - 999 MMR\n' +
            '🟡 **Gold & Below**: < 800 MMR',
          inline: false,
        }
      )
      .setFooter({ text: 'Rocket League 6mans • Designed to replace legacy queue bots' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
