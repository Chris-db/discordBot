import { EmbedBuilder, User } from 'discord.js';
import { Player, Match, getPlayersByIds } from '../database/queries';
import { getDivisionTier, getStreakBadge } from '../services/mmrService';

export const RL_COLORS = {
  ORANGE: 0xff5722,
  BLUE: 0x2979ff,
  GREEN: 0x00e676,
  PURPLE: 0xaa00ff,
  GOLD: 0xffb300,
  RED: 0xff1744,
  DARK: 0x263238,
};

/**
 * Builds the persistent Queue Panel Embed.
 */
export function buildQueuePanelEmbed(players: Player[]): EmbedBuilder {
  const count = players.length;
  const embed = new EmbedBuilder()
    .setTitle('🚀 ROCKET LEAGUE 6MANS QUEUE')
    .setColor(count === 6 ? RL_COLORS.GREEN : RL_COLORS.ORANGE)
    .setDescription(
      count === 0
        ? 'The queue is currently empty. Click **Join Queue** below to start!'
        : `**Current Queue (${count}/6):**\n\n` +
        players
          .map((p, idx) => {
            return `**${idx + 1}.** <@${p.discord_id}> — \`${p.mmr} MMR\``;
          })
          .join('\n')
    )
    .setFooter({
      text: 'Rocket League 6mans',
    })
    .setTimestamp();

  return embed;
}

/**
 * Builds the Mode Voting Embed when 6/6 players is reached.
 */
export function buildModeVoteEmbed(
  players: Player[],
  voteCounts: { captains: number; balanced: number; random: number }
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('🗳️ VOTE: TEAM SELECTION MODE')
    .setColor(RL_COLORS.BLUE)
    .setDescription(
      `👑 **Captains Draft:** \`${voteCounts.captains} votes\`\n` +
      `⚖️ **Balanced MMR:** \`${voteCounts.balanced} votes\`\n` +
      `🎲 **Random Teams:** \`${voteCounts.random} votes\``
    )
    .setFooter({ text: 'Voting closes in 30s or when 4 votes align' })
    .setTimestamp();

  return embed;
}

/**
 * Builds the Captains Draft Embed showing captains and remaining pool.
 */
export function buildCaptainsDraftEmbed(
  blueCaptain: Player,
  orangeCaptain: Player,
  blueTeam: Player[],
  orangeTeam: Player[],
  remaining: Player[],
  turn: 'BLUE' | 'ORANGE',
  pickNumber: number
): EmbedBuilder {
  const currentCaptain = turn === 'BLUE' ? blueCaptain : orangeCaptain;
  const embed = new EmbedBuilder()
    .setTitle('👑 CAPTAINS 1-2-1 DRAFT')
    .setColor(RL_COLORS.PURPLE)
    .setDescription(
      `**Turn:** ${turn === 'BLUE' ? '🔵 Blue' : '🟠 Orange'} (<@${currentCaptain.discord_id}>)\n` +
      `**Pick:** #${pickNumber} of 3`
    )
    .addFields(
      {
        name: '🔵 TEAM BLUE',
        value: blueTeam.map((p, idx) => `${idx === 0 ? '👑 ' : '👤 '} <@${p.discord_id}>`).join('\n') || 'None',
        inline: true,
      },
      {
        name: '🟠 TEAM ORANGE',
        value: orangeTeam.map((p, idx) => `${idx === 0 ? '👑 ' : '👤 '} <@${p.discord_id}>`).join('\n') || 'None',
        inline: true,
      },
      {
        name: '👥 AVAILABLE POOL',
        value: remaining.length > 0 ? remaining.map(p => `• <@${p.discord_id}> (\`${p.mmr}\`)`).join('\n') : 'None remaining',
        inline: false,
      }
    )
    .setFooter({ text: 'Select a teammate from the dropdown below' })
    .setTimestamp();

  return embed;
}

/**
 * Builds the Captain Verification Vote Embed when Captains mode wins.
 */
export function buildCaptainsVoteEmbed(
  blueCaptain: Player,
  orangeCaptain: Player,
  yesCount: number,
  noCount: number
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('👑 CAPTAIN VERIFICATION VOTE')
    .setColor(RL_COLORS.PURPLE)
    .setDescription(
      `Are these captains valid? Vote to proceed or randomize new captains:\n\n` +
      `🔵 **Blue Captain:** <@${blueCaptain.discord_id}>\n` +
      `🟠 **Orange Captain:** <@${orangeCaptain.discord_id}>\n\n` +
      `✅ **Yes, Proceed:** \`${yesCount} votes\`\n` +
      `🔄 **No, Randomize:** \`${noCount} votes\``
    )
    .setFooter({ text: '4 votes required to proceed or randomize • Voting closes in 30s' })
    .setTimestamp();
}

/**
 * Builds the Team Verification Vote Embed showing proposed Blue vs Orange teams.
 */
export function buildTeamsVoteEmbed(
  blueTeam: Player[],
  orangeTeam: Player[],
  yesCount: number,
  noCount: number,
  seenCount: number = 1,
  mode: 'random' | 'balanced' = 'random'
): EmbedBuilder {
  const isBalanced = mode === 'balanced';
  const rerollLabel = isBalanced ? 'No, Next Split' : 'No, Randomize';
  const blueMmr = Math.round(blueTeam.reduce((s, p) => s + p.mmr, 0) / (blueTeam.length || 1));
  const orangeMmr = Math.round(
    orangeTeam.reduce((s, p) => s + p.mmr, 0) / (orangeTeam.length || 1)
  );

  return new EmbedBuilder()
    .setTitle(`🎲 TEAM VERIFICATION VOTE — ${isBalanced ? 'BALANCED' : 'RANDOM'}`)
    .setColor(RL_COLORS.BLUE)
    .setDescription(
      `Are these teams valid? Vote to proceed, or re-roll for the ` +
      `${isBalanced ? 'next-closest balanced split' : 'next random matchup'}:\n\n` +
      `🔵 **Team Blue** (avg ${blueMmr}): ${blueTeam.map(p => `<@${p.discord_id}>`).join(', ')}\n` +
      `🟠 **Team Orange** (avg ${orangeMmr}): ${orangeTeam.map(p => `<@${p.discord_id}>`).join(', ')}\n\n` +
      `🎲 **Matchup ${seenCount}/10 seen** (No duplicate team pairings)\n\n` +
      `✅ **Yes, Proceed:** \`${yesCount} votes\`\n` +
      `🔄 **${rerollLabel}:** \`${noCount} votes\``
    )
    .setFooter({ text: '4 votes required to proceed or re-roll • Voting closes in 30s' })
    .setTimestamp();
}

/**
 * Builds the Active Match Card Embed showing Blue vs Orange and lobby details.
 */
export function buildActiveMatchEmbed(
  matchId: number,
  blueTeam: Player[],
  orangeTeam: Player[],
  rlName: string,
  rlPass: string,
  blueVoiceId?: string,
  orangeVoiceId?: string,
  reportStatus?: {
    blueVotes?: string[];
    orangeVotes?: string[];
    cancelVotes?: string[];
  }
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`🎮 MATCH #${matchId} — PRIVATE LOBBY`)
    .setColor(0x00b0ff)
    .setDescription(
      `Welcome to your private 3v3 match! Join your team's voice room and use the Rocket League credentials below to enter the lobby.`
    )
    .addFields({
      name: '🔐 LOBBY CREDENTIALS',
      value: `**Name:** \`${rlName}\`   •   **Password:** \`${rlPass}\``,
      inline: false,
    })
    .setFooter({ text: `Match #${matchId} • Click buttons below to report win or cancel` })
    .setTimestamp();

  const hasVotes =
    reportStatus &&
    ((reportStatus.blueVotes && reportStatus.blueVotes.length > 0) ||
      (reportStatus.orangeVotes && reportStatus.orangeVotes.length > 0) ||
      (reportStatus.cancelVotes && reportStatus.cancelVotes.length > 0));

  if (hasVotes) {
    embed.addFields({
      name: '📋 REPORT STATUS',
      value: `\`Blue Win: ${reportStatus.blueVotes?.length || 0}/4  |  Orange Win: ${reportStatus.orangeVotes?.length || 0}/4  |  Cancel: ${reportStatus.cancelVotes?.length || 0}/4\``,
      inline: false,
    });
  }

  return embed;
}

/**
 * Builds the Match Result Summary Embed after completion.
 */
export function buildMatchResultEmbed(
  matchId: number,
  winner: 'BLUE' | 'ORANGE',
  blueTeam: { player: Player; delta: number; newMmr: number }[],
  orangeTeam: { player: Player; delta: number; newMmr: number }[],
  durationStr?: string
): EmbedBuilder {
  const winnerTitle = winner === 'BLUE' ? '🔵 TEAM BLUE WINS!' : '🟠 TEAM ORANGE WINS!';
  const color = winner === 'BLUE' ? RL_COLORS.BLUE : RL_COLORS.ORANGE;

  const rosterLine = (item: { player: Player; delta: number; newMmr: number }) => {
    const streak = getStreakBadge(item.player.streak);
    const delta = item.delta >= 0 ? `+${item.delta}` : `${item.delta}`;
    return `• <@${item.player.discord_id}>: \`${item.newMmr} MMR\` (${delta})${
      streak ? ` ${streak.emoji}${item.player.streak}` : ''
    }`;
  };

  const blueText = blueTeam.map(rosterLine).join('\n');
  const orangeText = orangeTeam.map(rosterLine).join('\n');

  const description = durationStr
    ? `**⏱️ Match Duration:** \`${durationStr}\`\nELO ratings and leaderboards have been automatically updated!`
    : 'ELO ratings and leaderboards have been automatically updated!';

  const embed = new EmbedBuilder()
    .setTitle(`🏆 MATCH #${matchId} COMPLETED — ${winnerTitle}`)
    .setColor(color)
    .setDescription(description)
    .addFields(
      { name: '🔵 TEAM BLUE RESULTS', value: blueText, inline: true },
      { name: '🟠 TEAM ORANGE RESULTS', value: orangeText, inline: true }
    );

  // Call out the standout runs separately -- a 5-win streak deserves more than a suffix.
  const notableStreaks = [...blueTeam, ...orangeTeam]
    .filter(item => item.player.streak >= 3)
    .sort((a, b) => b.player.streak - a.player.streak)
    .map(item => {
      const badge = getStreakBadge(item.player.streak)!;
      return `**${badge.full}** — <@${item.player.discord_id}>`;
    });

  if (notableStreaks.length > 0) {
    embed.addFields({ name: '🔥 ON A RUN', value: notableStreaks.join('\n'), inline: false });
  }

  embed.setFooter({ text: 'Good games! Join the queue for another match.' }).setTimestamp();

  return embed;
}

/**
 * Builds the Public Read-Only Feed Card for #active-matches.
 * Shows teams and MMR without exposing the private lobby password.
 */
export function buildPublicFeedCardEmbed(
  matchId: number,
  status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED',
  bluePlayers: Player[],
  orangePlayers: Player[],
  winner?: 'BLUE' | 'ORANGE'
): EmbedBuilder {
  const blueAvg =
    bluePlayers.length > 0
      ? Math.round(bluePlayers.reduce((sum, p) => sum + p.mmr, 0) / bluePlayers.length)
      : 1000;
  const orangeAvg =
    orangePlayers.length > 0
      ? Math.round(orangePlayers.reduce((sum, p) => sum + p.mmr, 0) / orangePlayers.length)
      : 1000;

  const blueRoster = bluePlayers
    .map(p => `• <@${p.discord_id}> (\`${p.mmr} MMR\`)`)
    .join('\n');
  const orangeRoster = orangePlayers
    .map(p => `• <@${p.discord_id}> (\`${p.mmr} MMR\`)`)
    .join('\n');

  let title = `🚀 ACTIVE 6MANS MATCH #${matchId}`;
  let color = 0x00e676; // green for active
  let desc = 'Match is currently in progress! Watch the sidebar for live voice activity.';

  if (status === 'COMPLETED') {
    const winnerText = winner === 'BLUE' ? '🔵 TEAM BLUE WINS' : '🟠 TEAM ORANGE WINS';
    title = `🏆 MATCH #${matchId} COMPLETED — ${winnerText}`;
    color = winner === 'BLUE' ? RL_COLORS.BLUE : RL_COLORS.ORANGE;
    desc = 'Match has concluded and ELO ratings have been updated.';
  } else if (status === 'CANCELLED') {
    title = `❌ MATCH #${matchId} CANCELLED`;
    color = RL_COLORS.RED;
    desc = 'This match was cancelled by an Administrator or Mod.';
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(desc)
    .addFields(
      {
        name: `🔵 TEAM BLUE (Avg MMR: ${blueAvg})`,
        value: blueRoster || 'N/A',
        inline: true,
      },
      {
        name: `🟠 TEAM ORANGE (Avg MMR: ${orangeAvg})`,
        value: orangeRoster || 'N/A',
        inline: true,
      }
    )
    .setFooter({ text: `Rocket League 6mans Feed • Match #${matchId}` })
    .setTimestamp();

  return embed;
}

/**
 * Builds the Player Stats Embed.
 */
export function buildStatsEmbed(
  player: Player,
  rank: number = 0,
  totalPlayers: number = 0,
  avatarUrl?: string
): EmbedBuilder {
  return buildMyRankEmbed(player, rank, totalPlayers, avatarUrl);
}

/**
 * Builds the Leaderboard Embed.
 */
export function buildLeaderboardEmbed(
  players: Player[],
  page: number = 1,
  totalPlayers: number = players.length,
  topPlayerAvatarUrl?: string,
  hasImage: boolean = true
): EmbedBuilder {
  const totalPages = Math.max(1, Math.ceil(totalPlayers / 10));
  const startIdx = (page - 1) * 10;

  const embed = new EmbedBuilder()
    .setTitle('🏆 ROCKET LEAGUE 6MANS — SERVER ELO LEADERBOARD')
    .setColor(RL_COLORS.GOLD)
    .setDescription(
      players.length === 0
        ? 'No matches have been played yet!'
        : players
          .map((p, idx) => {
            const overallRank = startIdx + idx + 1;
            const medal =
              overallRank === 1
                ? '🥇 `#1`'
                : overallRank === 2
                  ? '🥈 `#2`'
                  : overallRank === 3
                    ? '🥉 `#3`'
                    : `**#${overallRank}.**`;

            return `${medal}  <@${p.discord_id}>  —  **\`${p.mmr} MMR\`**`;
          })
          .join('\n')
    )
    .setFooter({ text: `Page ${page} of ${totalPages} • Total Players: ${totalPlayers}` })
    .setTimestamp();

  if (topPlayerAvatarUrl) {
    embed.setThumbnail(topPlayerAvatarUrl);
  }

  if (hasImage) {
    embed.setImage('attachment://leaderboard.png');
  }

  return embed;
}

/**
 * Builds the ephemeral My Rank Embed when clicking the My Rank button.
 */
export function buildMyRankEmbed(
  player: Player,
  rank: number,
  totalPlayers: number,
  avatarUrl?: string
): EmbedBuilder {
  const tier = getDivisionTier(player.division);
  const totalGames = player.wins + player.losses;
  const winRate = totalGames > 0 ? ((player.wins / totalGames) * 100).toFixed(1) : '0.0';
  const streakBadge =
    player.streak > 0
      ? `🔥 ${player.streak} Win Streak`
      : player.streak < 0
        ? `❄️ ${Math.abs(player.streak)} Loss Streak`
        : '0';

  const rankText = rank > 0 ? `**#${rank}** out of ${totalPlayers} players` : 'Unranked';
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🏆';

  const embed = new EmbedBuilder()
    .setTitle(`${medal} YOUR 6MANS RANK STANDING`)
    .setColor(RL_COLORS.GOLD)
    .setDescription(
      `Here is your current standing on the server leaderboard:\n\n` +
      `**Position:** ${rankText}\n` +
      `**Player:** <@${player.discord_id}> • [👤 View Profile](https://discord.com/users/${player.discord_id})`
    )
    .addFields(
      { name: '🏆 Rank Tier', value: `${tier.emoji} **${tier.name}**`, inline: true },
      { name: '⚡ ELO Rating', value: `\`${player.mmr} MMR\``, inline: true },
      { name: '📈 Win Rate', value: `\`${winRate}%\` (${player.wins}W - ${player.losses}L)`, inline: true },
      { name: '🔥 Current Streak', value: `\`${streakBadge}\``, inline: true },
      { name: '🎮 Total Matches', value: `\`${totalGames}\``, inline: true }
    )
    .setFooter({ text: 'Rocket League 6mans Competitive Season' })
    .setTimestamp();

  if (avatarUrl) {
    embed.setThumbnail(avatarUrl);
  }

  return embed;
}

/**
 * Builds the Match History Embed showing recent completed matches.
 */
export function buildMatchHistoryEmbed(matches: Match[], targetUser?: User): EmbedBuilder {
  const title = targetUser
    ? `📜 ${targetUser.username.toUpperCase()}'S RECENT MATCH HISTORY`
    : '📜 SERVER 6MANS MATCH HISTORY';

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(RL_COLORS.BLUE)
    .setDescription(
      matches.length === 0
        ? 'No completed matches found in history yet!'
        : 'Below are the most recently completed 3v3 matches:\n'
    )
    .setFooter({ text: 'Rocket League 6mans • Match History System' })
    .setTimestamp();

  if (matches.length > 0) {
    for (const m of matches.slice(0, 5)) {
      const isBlueWin = m.winner === 'BLUE';
      const winnerBadge = isBlueWin ? '🔵 **TEAM BLUE WON**' : '🟠 **TEAM ORANGE WON**';
      const blueMentions = m.blue_team.map(id => `<@${id}>`).join(', ');
      const orangeMentions = m.orange_team.map(id => `<@${id}>`).join(', ');

      const dateStr = m.completed_at
        ? new Date(m.completed_at).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : 'Recent';

      embed.addFields({
        name: `🎮 Match #${m.match_id}  •  ${winnerBadge}  (${dateStr})`,
        value: `**🔵 Blue:** ${blueMentions || 'N/A'}\n**🟠 Orange:** ${orangeMentions || 'N/A'}`,
        inline: false,
      });
    }
    embed.setImage('attachment://history.png');
  }

  return embed;
}

/**
 * Builds the Double or Nothing Consensus Embed (6/6 Required).
 */
export function buildGambleConsensusEmbed(
  matchId: number,
  blueTeam: Player[],
  orangeTeam: Player[],
  agreedIds: string[],
  timeRemainingSec: number,
  declinedBy?: string
): EmbedBuilder {
  const agreedCount = agreedIds.length;
  const embed = new EmbedBuilder()
    .setTitle(`🎰 DOUBLE OR NOTHING: WHEEL OF FATE (Match #${matchId})`)
    .setColor(declinedBy ? RL_COLORS.RED : RL_COLORS.GOLD)
    .setDescription(
      declinedBy
        ? `❌ <@${declinedBy}> declined the gamble. Original match results stand!`
        : `All 6 players must agree within **${timeRemainingSec}s** to spin the Wheel of Fate!\n\n` +
          `**⚖️ The Stakes:**\n` +
          `• **If Losing Team wins the Wheel (50%):** 🛡️ **INVERTED!** Match outcome is flipped (\`+MMR\` for Losers, \`-MMR\` for Winners).\n` +
          `• **If Winning Team wins the Wheel (50%):** 🔥 **DOUBLED!** MMR gains & losses are doubled (\`+2x MMR\` / \`-2x MMR\`).`
    );

  const formatTeam = (players: Player[]) =>
    players
      .map((p) => {
        const check = agreedIds.includes(p.discord_id) ? '✅' : '⏳';
        return `${check} **${p.username}**`;
      })
      .join('\n');

  embed.addFields(
    { name: `🔵 Team Blue (${blueTeam.filter(p => agreedIds.includes(p.discord_id)).length}/3 Agreed)`, value: formatTeam(blueTeam), inline: true },
    { name: `🟠 Team Orange (${orangeTeam.filter(p => agreedIds.includes(p.discord_id)).length}/3 Agreed)`, value: formatTeam(orangeTeam), inline: true }
  );

  if (!declinedBy) {
    embed.setFooter({ text: `Consensus: ${agreedCount} / 6 Players Agreed • ${timeRemainingSec}s Remaining` });
  }

  return embed;
}

/**
 * Builds the Spinning Wheel of Fate Embed (animated ticker).
 */
export function buildGambleSpinningEmbed(step: 1 | 2, matchId: number): EmbedBuilder {
  const ticker =
    step === 1
      ? `░░░ 🌀 **[🔵 BLUE]** — **[🟠 ORANGE]** — **[🔵 BLUE]** — **[🟠 ORANGE]** 🌀 ░░░`
      : `░░░░░░░░░░ ⬇️ **POINTER** ⬇️ ░░░░░░░░░░\n       ... **[🟠 ORANGE]** — **[🔵 BLUE]** — **[❓ ???]** ...`;

  const title =
    step === 1
      ? `🎰 THE WHEEL OF FATE IS SPINNING... (Match #${matchId})`
      : `🎰 THE WHEEL IS SLOWING DOWN... (Match #${matchId})`;

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(RL_COLORS.GOLD)
    .setDescription(`**6/6 Agreed!** The Fate of Match #${matchId} is being decided!\n\n${ticker}`)
    .setFooter({ text: 'Rocket League 6mans • High-Stakes Wheel of Fate' })
    .setTimestamp();
}
