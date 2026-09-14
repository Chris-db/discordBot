import {
  Player,
  GuildDivision,
  getDivisions,
  getLeaderboard,
  getMatchHistory,
  getPlayer,
  getPlayerRank,
  getTotalPlayersCount,
} from '../database/queries';

/**
 * What the profile card draws, worked out from the database before any pixels are drawn.
 *
 * The card used to compute its own progress bar from hardcoded MMR bands -- the fixed
 * five-rank ladder that divisions replaced -- so a one-ladder server saw "Next: Rank B"
 * and a Rank C player at 1016 saw a bar 85% full (measured from 0). Everything here reads
 * the guild's own division rows and is scoped to one (server, size) ladder, the same as
 * every other number on the card.
 */
export interface ProfileCardData {
  player: Player;
  /** Position within the player's division at this size; 0 when unranked. */
  rank: number;
  totalPlayers: number;
  bar: MmrBar;
  /** Undefined until the player has won a game with someone. */
  bestTeammate?: BestTeammate;
}

export interface MmrBar {
  /** Where the bar starts and where it is full. */
  from: number;
  to: number;
  /** 0..1, already clamped. */
  progress: number;
  /** Right-hand caption: what the bar is measuring toward. */
  label: string;
}

export interface BestTeammate {
  discord_id: string;
  username: string;
  wins: number;
  /** Games played together, win or lose -- the tie-breaker. */
  games: number;
}

/**
 * The progress bar for a player, given their ladder.
 *
 * Ranked server: from the division's starting MMR to its promotion line, captioned with
 * the division it promotes into. "Ranked" is judged the way /setup judges it -- a higher
 * division with a queue channel registered -- so a one-ladder server, whose B..S rows
 * exist but have no channel, is not told about a Rank B it does not have.
 *
 * No next rank (one ladder, or the top division): distance to whoever leads the ladder,
 * which is the thing a small server actually races for. The leader's own bar is full.
 */
export function mmrBarFor(player: Player, ladder: GuildDivision[], leader: Player | undefined): MmrBar {
  const index = ladder.findIndex(d => d.division === player.division);
  const current = ladder[index];
  const next = ladder.slice(index + 1).find(d => d.queue_channel_id);
  const from = current?.default_mmr ?? player.mmr;

  if (current && next && current.promote_at !== null) {
    return bar(from, current.promote_at, player.mmr, `Promotes to ${next.display_name} at ${current.promote_at}`);
  }

  if (!leader || leader.discord_id === player.discord_id) {
    return { from, to: player.mmr, progress: 1, label: "You're on top 👑" };
  }
  return bar(from, leader.mmr, player.mmr, `Ladder top: ${leader.mmr} (${leader.username})`);
}

function bar(from: number, to: number, mmr: number, label: string): MmrBar {
  const progress = to > from ? Math.max(0, Math.min(1, (mmr - from) / (to - from))) : mmr >= to ? 1 : 0;
  return { from, to, progress, label };
}

/**
 * The teammate a player has won the most with on this ladder, ties broken by games played
 * together. Test bots never count. Undefined until there is at least one win with someone.
 */
export function getBestTeammate(guildId: string, teamSize: number, discordId: string): BestTeammate | undefined {
  const tally = new Map<string, { wins: number; games: number }>();
  for (const match of getMatchHistory(guildId, 100_000, discordId, teamSize)) {
    const onBlue = match.blue_team.includes(discordId);
    const team = onBlue ? match.blue_team : match.orange_team;
    const won = match.winner === (onBlue ? 'BLUE' : 'ORANGE');
    for (const mate of team) {
      if (mate === discordId || mate.startsWith('test_bot_')) continue;
      const t = tally.get(mate) ?? { wins: 0, games: 0 };
      t.games += 1;
      if (won) t.wins += 1;
      tally.set(mate, t);
    }
  }

  let best: BestTeammate | undefined;
  for (const [mate, t] of tally) {
    if (t.wins === 0) continue;
    if (!best || t.wins > best.wins || (t.wins === best.wins && t.games > best.games)) {
      best = { discord_id: mate, username: getPlayer(guildId, teamSize, mate)?.username ?? mate, ...t };
    }
  }
  return best;
}

/** Everything the card needs for one player on one ladder. */
export function loadProfileCard(guildId: string, teamSize: number, player: Player): ProfileCardData {
  const rankData = getPlayerRank(guildId, teamSize, player.discord_id);
  const ladder = getDivisions(guildId, teamSize);
  const leader = getLeaderboard(guildId, teamSize, player.division, 1)[0];
  return {
    player,
    rank: rankData ? rankData.rank : 0,
    totalPlayers: getTotalPlayersCount(guildId, teamSize, player.division),
    bar: mmrBarFor(player, ladder, leader),
    bestTeammate: getBestTeammate(guildId, teamSize, player.discord_id),
  };
}
