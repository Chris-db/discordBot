import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
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
        'Welcome to **Rocket League 6mans**! A competitive pick-up game system at **2v2, 3v3 or 4v4**, with automated drafting, lobbies, voice channels, and ELO tracking.'
      )
      .addFields(
        {
          name: '🎮 HOW TO PLAY',
          value:
            '1. Click **Join Queue** on the interactive Queue Panel. Each queue channel is a fixed size — the panel says which.\n' +
            '2. When the queue fills, vote for **Captains Draft**, **Balanced MMR**, or **Random Teams**.\n' +
            '3. The bot generates a private **Rocket League Lobby Name & Password** and creates temporary **Team Blue 🔵** and **Team Orange 🟠** voice channels.\n' +
            '4. After the match, click **Report Blue Win** or **Report Orange Win** to record the score and update ELO ratings.',
          inline: false,
        },
        {
          name: '📊 SIZES ARE SEPARATE LADDERS',
          value:
            'Your 2v2, 3v3 and 4v4 ratings are completely independent — separate MMR, W/L, division and leaderboard. ' +
            'Winning at 3v3 does nothing to your 2v2 rank. Most commands take an optional `size:` (defaulting to 3v3).',
          inline: false,
        },
        {
          name: '💬 PLAYER COMMANDS',
          value:
            '`/queue status` — Check who is waiting in the queue\n' +
            '`/stats [user] [size]` — View ELO rating, division, wins, losses, and win rate\n' +
            '`/leaderboard [division] [size]` — Top players in a division (defaults to yours)\n' +
            '`/history [user] [size]` — View completed match history\n' +
            '`/match list` — View all active matches\n' +
            '`/division list [size]` — See every division and its promotion thresholds\n' +
            '`/division check [user] [size]` — See a player\'s division and season standing\n' +
            '`/season info` — Current season, matches played, division sizes\n' +
            '`/season history` — Past seasons and their champions\n' +
            '`/feedback <message>` — Send a bug report or suggestion to whoever runs the bot',
          inline: false,
        },
        {
          name: '🛠️ ADMIN / MOD COMMANDS',
          value:
            '`/queue panel [size] [division]` — Deploy the Queue Panel and set this channel\'s size\n' +
            '`/queue add <user>` — Manually add a player to the queue\n' +
            '`/queue remove <user>` — Manually remove a player from the queue\n' +
            '`/queue clear` — Clear the current queue\n' +
            '`/queue fill-bots` — Fill queue with simulated bots for testing\n' +
            '`/queue force-pop [mode]` — Immediately pop queue with bots\n' +
            '`/match report <id> <winner>` — Force report a match winner\n' +
            '`/match cancel <id>` — Force cancel an active match\n' +
            '`/match cleanup [id]` — Clean up temporary match channels\n' +
            '`/replay check <file…> [match]` — Read the score out of saved .replay files to settle a dispute\n' +
            '`/theme set|reset|preset|list|show` — This server\'s colours for the image cards\n' +
            '`/set-mmr <user> <mmr> [size]` — Adjust a player\'s ELO rating\n' +
            '`/ban add <user> <duration> [reason]` — Ban a player from queuing\n' +
            '`/ban remove <user>` — Remove an active queue ban\n' +
            '`/ban check <user>` — Check ban status for a player\n' +
            '`/ban list` — List all active queue bans\n' +
            '`/division place <user> <division> [size]` — Place a player into a division\n' +
            '`/division configure <division> [size]` — Set a division\'s channel, role or thresholds\n' +
            '`/season end <confirm>` — End the season: promote, relegate, reset MMR',
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
          name: '🏆 RANK DIVISIONS',
          value:
            'You are **placed** into a division by an admin, and you stay there for the ' +
            'whole season — MMR moves your position inside your division, not between them. ' +
            'At a season reset you promote or relegate based on where you finished.\n\n' +
            '👑 **Rank S** — starts at 1900 MMR\n' +
            '⚔️ **Rank X** — starts at 1700, relegates below 1600\n' +
            '🟣 **Rank A** — starts at 1500, promotes at 1600, relegates below 1400\n' +
            '🔵 **Rank B** — starts at 1300, promotes at 1400, relegates below 1200\n' +
            '🟢 **Rank C** — starts at 1000, promotes at 1200\n\n' +
            '*Defaults — admins can retune them per division with `/division configure`.*',
          inline: false,
        }
      )
      .setFooter({ text: 'Rocket League 6mans • Designed to replace legacy queue bots' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
