import { describe, it, expect } from 'vitest';
import { summariseSeries, formatSeries } from '../src/services/replayReport';
import { ReplayHeader } from '../src/utils/replayHeader';
import { Match } from '../src/database/queries';

const game = (overrides: Partial<ReplayHeader>): ReplayHeader => ({
  replayId: Math.random().toString(36).slice(2),
  matchType: 'Private',
  teamSize: 3,
  blueScore: 1,
  orangeScore: 0,
  winner: 'BLUE',
  players: [],
  ...overrides,
});

const match = (overrides: Partial<Match> = {}): Match =>
  ({
    match_id: 42,
    guild_id: 'g',
    channel_id: 'c',
    team_size: 3,
    state: 'IN_PROGRESS',
    blue_team: ['b1'],
    orange_team: ['o1'],
    started_at: '2026-09-11T18:00:00.000Z',
    ...overrides,
  }) as Match;

describe('summariseSeries', () => {
  it('orders games by their own clock and tallies the series', () => {
    const s = summariseSeries([
      game({ replayId: 'third', matchStartEpoch: 3000, winner: 'ORANGE', blueScore: 0, orangeScore: 2 }),
      game({ replayId: 'first', matchStartEpoch: 1000 }),
      game({ replayId: 'second', matchStartEpoch: 2000 }),
    ]);
    expect(s.games.map(g => g.replayId)).toEqual(['first', 'second', 'third']);
    expect(s.blueWins).toBe(2);
    expect(s.orangeWins).toBe(1);
    expect(s.seriesWinner).toBe('BLUE');
    expect(s.warnings).toEqual([]);
  });

  it('flags a duplicate upload, a non-private game, a size mismatch and a game from before the match', () => {
    const s = summariseSeries(
      [
        game({ replayId: 'dup', matchStartEpoch: 1_757_613_600 }), // 18:00Z on 2026-09-11
        game({ replayId: 'dup', matchStartEpoch: 1_757_613_900 }),
        game({ replayId: 'ranked', matchType: 'Online', matchStartEpoch: 1_757_614_200 }),
        game({ replayId: 'twos', teamSize: 2, matchStartEpoch: 1_757_614_500 }),
        game({ replayId: 'old', matchStartEpoch: 1_757_600_000 }),
      ],
      match()
    );
    const text = s.warnings.join('\n');
    expect(text).toMatch(/uploaded more than once/);
    expect(text).toMatch(/\*\*Online\*\* match/);
    expect(text).toMatch(/is 2v2; Match #42 is 3v3/);
    expect(text).toMatch(/played before Match #42 started/);
  });

  it('calls a level series a draw', () => {
    const s = summariseSeries([game({}), game({ winner: 'ORANGE', blueScore: 0, orangeScore: 1 })]);
    expect(s.seriesWinner).toBe('DRAW');
  });
});

describe('formatSeries', () => {
  it('shows one scoreboard per game, the tally, and how to settle it', () => {
    const s = summariseSeries([
      game({
        matchStartEpoch: 1000,
        blueScore: 3,
        orangeScore: 1,
        totalSecondsPlayed: 302,
        players: [
          { name: 'Zeph', team: 0, score: 500, goals: 2, assists: 1, saves: 0, shots: 3, bot: false },
          { name: 'ravi_rl1', team: 1, score: 200, goals: 1, assists: 0, saves: 2, shots: 1, bot: false },
        ],
      }),
      game({ matchStartEpoch: 2000, blueScore: 2, orangeScore: 0 }),
    ]);
    const text = formatSeries(s, match(), {
      blue: [{ username: 'zephyerrl' } as any],
      orange: [{ username: 'ravi' } as any],
    });

    expect(text).toContain('**Match #42** · IN PROGRESS');
    expect(text).toContain('🔵 zephyerrl');
    expect(text).toContain('**Game 1** — 🔵 **3** – **1** 🟠 · 5:02');
    expect(text).toMatch(/Zeph\s+2g\s+1a\s+0s\s+500/);
    expect(text).toContain('**Series:** 🔵 2 – 0 🟠');
    expect(text).toContain('/match report match_id:42');
  });

  it('stays under the Discord message cap for five full 4v4 games', () => {
    const roster = (team: 0 | 1) =>
      Array.from({ length: 4 }, (_, i) => ({
        name: `a_thirteen_c${i}`, team, score: 1000, goals: 10, assists: 10, saves: 10, shots: 10, bot: false,
      }));
    const games = Array.from({ length: 5 }, (_, i) =>
      game({ teamSize: 4, matchStartEpoch: 1000 + i, totalSecondsPlayed: 600, players: [...roster(0), ...roster(1)] })
    );
    expect(formatSeries(summariseSeries(games), match({ team_size: 4 })).length).toBeLessThan(2000);
  });
});
