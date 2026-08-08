import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import { getOrCreatePlayer, saveQueue, getQueue, Player } from '../src/database/queries';
import {
  createBalancedTeams,
  rankMatchupsByBalance,
  getMatchupMmrDiff,
} from '../src/services/draftService';
import { parseDurationToIso } from '../src/commands/ban';
import { removePlayerFromWaitingQueues } from '../src/services/queuePanel';
import { resolveWinningMode, TeamMode } from '../src/services/votingService';

/** Minimal stand-in for a discord.js Client: every lookup misses, nothing is sent. */
const fakeClient = {
  channels: { fetch: async () => null },
  guilds: { fetch: async () => null },
  users: { fetch: async () => null },
  user: { id: 'bot_1' },
} as any;

const makePlayer = (id: string, mmr: number): Player => ({
  discord_id: id,
  username: `Player_${id}`,
  mmr,
  wins: 0,
  losses: 0,
  streak: 0,
  created_at: new Date().toISOString(),
});

const sixPlayers = () => [
  makePlayer('p1', 1500),
  makePlayer('p2', 1300),
  makePlayer('p3', 1100),
  makePlayer('p4', 1050),
  makePlayer('p5', 950),
  makePlayer('p6', 900),
];

describe('P1 regressions', () => {
  beforeEach(() => {
    db.exec('DELETE FROM player_ladders; DELETE FROM players; DELETE FROM active_queues; DELETE FROM matches; DELETE FROM bans;');
  });

  // ---- P1-11 -------------------------------------------------------------

  describe('balanced re-roll stays balanced', () => {
    it('still returns the most balanced split when nothing has been seen', () => {
      const players = sixPlayers();
      const best = createBalancedTeams(players);
      const optimalDiff = getMatchupMmrDiff(rankMatchupsByBalance(players)[0]);

      expect(getMatchupMmrDiff(best)).toBe(optimalDiff);
      expect(best.blueTeam.length).toBe(3);
      expect(best.orangeTeam.length).toBe(3);
    });

    it('walks down to the next-closest split instead of repeating the rejected one', () => {
      const players = sixPlayers();
      const seen: string[] = [];
      const diffs: number[] = [];

      // Reject five splits in a row. Each must be a new matchup, and balance must only
      // ever get worse -- if this fell back to random, the sequence would jump around.
      for (let i = 0; i < 5; i++) {
        const result = createBalancedTeams(players, seen);
        expect(seen).not.toContain(result.matchupKey!);
        seen.push(result.matchupKey!);
        diffs.push(getMatchupMmrDiff(result));
      }

      const monotonic = [...diffs].sort((a, b) => a - b);
      expect(diffs).toEqual(monotonic);
    });

    it('restarts from the most balanced split once all 10 matchups are exhausted', () => {
      const players = sixPlayers();
      const seen = rankMatchupsByBalance(players).map(m => m.matchupKey!);
      expect(seen.length).toBe(10);

      const result = createBalancedTeams(players, seen);
      expect(getMatchupMmrDiff(result)).toBe(getMatchupMmrDiff(rankMatchupsByBalance(players)[0]));
    });

    it('does not always put the same player on Blue', () => {
      const players = sixPlayers();
      const blueSides = new Set<string>();
      for (let i = 0; i < 40; i++) {
        blueSides.add(createBalancedTeams(players).blueTeam.map(p => p.discord_id).sort().join(','));
      }
      // The split is deterministic, so the only variation available is the colour flip.
      expect(blueSides.size).toBe(2);
    });
  });

  // ---- P1-12 -------------------------------------------------------------

  describe('mode vote tie-breaking', () => {
    const winnersOver = (counts: Record<TeamMode, number>, runs = 300) => {
      const seen = new Set<TeamMode>();
      for (let i = 0; i < runs; i++) seen.add(resolveWinningMode(counts).winningMode);
      return seen;
    };

    it('does not hand every tie to balanced', () => {
      // Two-way tie: balanced used to win this 100% of the time.
      const winners = winnersOver({ captains: 2, balanced: 2, random: 0 });
      expect(winners).toEqual(new Set<TeamMode>(['captains', 'balanced']));
    });

    it('falls back to balanced when nobody voted at all', () => {
      // An empty tally is an absent lobby, not a preference -- don't coin-flip an
      // unresponsive queue into a captains draft it has to keep interacting with.
      const winners = winnersOver({ captains: 0, balanced: 0, random: 0 });
      expect(winners).toEqual(new Set<TeamMode>(['balanced']));
    });

    it('coin-flips a real tie even when it is only one vote each', () => {
      const winners = winnersOver({ captains: 1, balanced: 1, random: 0 });
      expect(winners).toEqual(new Set<TeamMode>(['captains', 'balanced']));
    });

    it('never picks a mode that is not tied for the lead', () => {
      const winners = winnersOver({ captains: 3, balanced: 1, random: 1 });
      expect(winners).toEqual(new Set<TeamMode>(['captains']));
    });

    it('reports the tie so the message can explain what happened', () => {
      expect(resolveWinningMode({ captains: 2, balanced: 2, random: 1 }).tiedModes.sort()).toEqual([
        'balanced',
        'captains',
      ]);
      expect(resolveWinningMode({ captains: 4, balanced: 1, random: 0 }).tiedModes).toEqual([
        'captains',
      ]);
    });
  });

  // ---- P1-13 -------------------------------------------------------------

  describe('ban duration parsing', () => {
    const minutesFromNow = (iso: string) =>
      Math.round((new Date(iso).getTime() - Date.now()) / 60_000);

    it('reads 30m as thirty minutes, not thirty months', () => {
      expect(minutesFromNow(parseDurationToIso('30m')!)).toBe(30);
    });

    it('reads 1mo as a month', () => {
      const days = Math.round(
        (new Date(parseDurationToIso('1mo')!).getTime() - Date.now()) / 86_400_000
      );
      expect(days).toBeGreaterThanOrEqual(28);
      expect(days).toBeLessThanOrEqual(31);
    });

    it('handles the other units', () => {
      expect(minutesFromNow(parseDurationToIso('2h')!)).toBe(120);
      expect(minutesFromNow(parseDurationToIso('1d')!)).toBe(1440);
      expect(minutesFromNow(parseDurationToIso('1w')!)).toBe(10080);
    });

    it('returns null for a permanent ban', () => {
      expect(parseDurationToIso('permanent')).toBeNull();
      expect(parseDurationToIso('perm')).toBeNull();
    });

    it('rejects garbage and zero-length durations', () => {
      expect(() => parseDurationToIso('soon')).toThrow();
      expect(() => parseDurationToIso('5y')).toThrow();
      expect(() => parseDurationToIso('0m')).toThrow();
    });
  });

  // ---- ban leaves the player in the queue ---------------------------------

  describe('banning removes the player from waiting queues', () => {
    const seedQueue = (channelId: string, state: string, playerIds: string[]) => {
      saveQueue({
        channel_id: channelId,
        guild_id: 'g1',
        player_ids: playerIds,
        player_join_times: Object.fromEntries(playerIds.map(id => [id, Date.now()])),
        state: state as any,
        vote_counts: {},
      } as any);
    };

    it('pulls the banned player out of every waiting queue in the guild', async () => {
      playersInDb(['banned', 'other']);
      seedQueue('chan_a', 'WAITING', ['banned', 'other']);
      seedQueue('chan_b', 'WAITING', ['other', 'banned']);

      const affected = await removePlayerFromWaitingQueues(fakeClient, 'g1', 'banned');

      expect(affected.sort()).toEqual(['chan_a', 'chan_b']);
      expect(getQueue('chan_a')!.player_ids).toEqual(['other']);
      expect(getQueue('chan_b')!.player_ids).toEqual(['other']);
      expect(getQueue('chan_a')!.player_join_times).not.toHaveProperty('banned');
    });

    it('leaves a popped queue alone so the other five are not stranded', async () => {
      playersInDb(['banned', 'other']);
      seedQueue('chan_live', 'READY_CHECK', ['banned', 'other']);

      const affected = await removePlayerFromWaitingQueues(fakeClient, 'g1', 'banned');

      expect(affected).toEqual([]);
      expect(getQueue('chan_live')!.player_ids).toContain('banned');
    });

    it('does not touch queues in another guild', async () => {
      playersInDb(['banned']);
      saveQueue({
        channel_id: 'chan_other_guild',
        guild_id: 'g2',
        player_ids: ['banned'],
        player_join_times: {},
        state: 'WAITING',
        vote_counts: {},
      } as any);

      const affected = await removePlayerFromWaitingQueues(fakeClient, 'g1', 'banned');

      expect(affected).toEqual([]);
      expect(getQueue('chan_other_guild')!.player_ids).toEqual(['banned']);
    });
  });
});

function playersInDb(ids: string[]) {
  for (const id of ids) getOrCreatePlayer('g1', 3, id, `User_${id}`);
}
