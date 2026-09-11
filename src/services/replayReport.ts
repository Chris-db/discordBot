import { Match, Player } from '../database/queries';
import { ReplayHeader } from '../utils/replayHeader';
import { parseDbTimestamp } from '../utils/time';

/**
 * Turns one or more parsed replays into the text an admin reads when settling a
 * disputed report: a scoreboard per game, the series tally, and anything about the
 * files that does not add up. Pure -- the command does the fetching and replying.
 */

export interface SeriesSummary {
  /** Games in the order they were played, by the replay's own clock. */
  games: ReplayHeader[];
  blueWins: number;
  orangeWins: number;
  seriesWinner: 'BLUE' | 'ORANGE' | 'DRAW';
  warnings: string[];
}

function gameStart(h: ReplayHeader): number {
  if (h.matchStartEpoch) return h.matchStartEpoch * 1000;
  // "2026-09-07 20-59-32" is the recording PC's local time; good enough to order games.
  if (h.date) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})$/.exec(h.date);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }
  return 0;
}

export function summariseSeries(replays: ReplayHeader[], match?: Match): SeriesSummary {
  const games = [...replays].sort((a, b) => gameStart(a) - gameStart(b));
  const warnings: string[] = [];

  let blueWins = 0;
  let orangeWins = 0;
  for (const g of games) {
    if (g.winner === 'BLUE') blueWins++;
    else if (g.winner === 'ORANGE') orangeWins++;
  }

  const ids = new Set(games.map(g => g.replayId).filter(Boolean));
  if (ids.size < games.length) warnings.push('The same game was uploaded more than once.');

  for (const [i, g] of games.entries()) {
    const label = games.length > 1 ? `Game ${i + 1}` : 'This replay';
    if (g.matchType && g.matchType !== 'Private') {
      warnings.push(`${label} is a **${g.matchType}** match, not a private lobby.`);
    }
    if (match && g.teamSize !== match.team_size) {
      warnings.push(`${label} is ${g.teamSize}v${g.teamSize}; Match #${match.match_id} is ${match.team_size}v${match.team_size}.`);
    }
    if (match?.started_at && gameStart(g) > 0) {
      const started = parseDbTimestamp(match.started_at);
      if (gameStart(g) < started - 10 * 60_000) {
        warnings.push(`${label} was played before Match #${match.match_id} started.`);
      }
    }
    if (g.winner === 'DRAW') warnings.push(`${label} has no winner (level score, no forfeit).`);
  }

  const seriesWinner: SeriesSummary['seriesWinner'] =
    blueWins === orangeWins ? 'DRAW' : blueWins > orangeWins ? 'BLUE' : 'ORANGE';

  return { games, blueWins, orangeWins, seriesWinner, warnings };
}

const clock = (secs?: number): string => {
  if (!secs) return '';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return ` · ${m}:${String(s).padStart(2, '0')}`;
};

/** One game as a fixed-width scoreboard, sorted by score within each team. */
export function formatGame(h: ReplayHeader, label: string): string {
  const side = (team: 0 | 1) =>
    h.players
      .filter(p => p.team === team)
      .sort((a, b) => b.score - a.score)
      .map(p => `${p.name.slice(0, 13).padEnd(13)} ${String(p.goals).padStart(2)}g ${String(p.assists).padStart(2)}a ${String(p.saves).padStart(2)}s ${String(p.score).padStart(4)}`)
      .join('\n');

  const when = h.matchStartEpoch ? ` · <t:${h.matchStartEpoch}:t>` : '';
  const header = `**${label}** — 🔵 **${h.blueScore}** – **${h.orangeScore}** 🟠${clock(h.totalSecondsPlayed)}${when}`;
  return `${header}\n\`\`\`\nBLUE\n${side(0) || '(nobody)'}\n\nORANGE\n${side(1) || '(nobody)'}\n\`\`\``;
}

/** The whole reply: games, tally, warnings, and what the bot thinks of the match. */
export function formatSeries(
  summary: SeriesSummary,
  match?: Match,
  rosters?: { blue: Player[]; orange: Player[] }
): string {
  const parts: string[] = [];

  if (match) {
    const names = (team: Player[]) => team.map(p => p.username).join(', ') || '—';
    parts.push(
      `**Match #${match.match_id}** · ${match.state.replace('_', ' ')}` +
        (match.winner && match.winner !== 'NONE' ? ` · reported winner **${match.winner}**` : '') +
        (rosters ? `\n🔵 ${names(rosters.blue)}\n🟠 ${names(rosters.orange)}` : '') +
        `\n-# Blue and Orange below are the lobby's teams. If everyone joined the side the bot gave them, they match; check the names either way.`
    );
  }

  summary.games.forEach((g, i) => {
    parts.push(formatGame(g, summary.games.length > 1 ? `Game ${i + 1}` : 'Replay'));
  });

  if (summary.games.length > 1) {
    const verdict =
      summary.seriesWinner === 'DRAW'
        ? 'level'
        : `**${summary.seriesWinner === 'BLUE' ? '🔵 Blue' : '🟠 Orange'}** leads`;
    parts.push(`**Series:** 🔵 ${summary.blueWins} – ${summary.orangeWins} 🟠 · ${verdict}`);
  }

  if (summary.warnings.length > 0) {
    parts.push(summary.warnings.map(w => `⚠️ ${w}`).join('\n'));
  }

  if (match && match.state === 'IN_PROGRESS') {
    parts.push(`-# To settle it: \`/match report match_id:${match.match_id} winner:…\``);
  }

  return parts.join('\n\n');
}
