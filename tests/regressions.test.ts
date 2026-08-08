import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import {
  getOrCreatePlayer,
  getPlayersByIds,
  createMatch,
  getMatch,
  mutateMatchReportStatus,
  mutateMatchGambleStatus,
  mutateQueue,
  saveQueue,
  getQueue,
  getAllLiveMatches,
} from '../src/database/queries';
import { cancelMatch } from '../src/services/matchService';
import { sweepStaleMatches } from '../src/services/queueTimeout';
import config from '../src/config';

/** Minimal stand-in for a discord.js Client: every lookup misses, nothing is sent. */
const fakeClient = {
  channels: { fetch: async () => null },
  guilds: { fetch: async () => null },
  users: { fetch: async () => null },
  user: { id: 'bot_1' },
} as any;

describe('Phase 1 regressions', () => {
  beforeEach(() => {
    db.exec('DELETE FROM player_ladders; DELETE FROM players; DELETE FROM active_queues; DELETE FROM matches; DELETE FROM bans;');
  });

  // ---- P0-1 --------------------------------------------------------------

  describe('getPlayersByIds ordering', () => {
    it('returns players in the order they were requested, not in id order', () => {
      getOrCreatePlayer('g1', 3, 'aaa', 'Alpha');
      getOrCreatePlayer('g1', 3, 'bbb', 'Bravo');
      getOrCreatePlayer('g1', 3, 'ccc', 'Charlie');

      // SQLite serves `IN` from the discord_id primary-key index, so the raw row order
      // is aaa,bbb,ccc regardless of what we ask for.
      expect(getPlayersByIds('g1', 3, ['ccc', 'aaa', 'bbb']).map(p => p.discord_id)).toEqual([
        'ccc',
        'aaa',
        'bbb',
      ]);
    });

    it('keeps the captain at index 0 so the crown renders on the right player', () => {
      // 'zzz_cap' sorts last by id but is the captain, i.e. index 0 of the team.
      getOrCreatePlayer('g1', 3, 'zzz_cap', 'Captain');
      getOrCreatePlayer('g1', 3, 'aaa_pick', 'FirstPick');
      getOrCreatePlayer('g1', 3, 'mmm_pick', 'SecondPick');

      const blueTeam = ['zzz_cap', 'aaa_pick', 'mmm_pick'];
      expect(getPlayersByIds('g1', 3, blueTeam)[0].discord_id).toBe('zzz_cap');
    });

    it('drops ids that have no player row rather than returning holes', () => {
      getOrCreatePlayer('g1', 3, 'real', 'Real');
      const result = getPlayersByIds('g1', 3, ['real', 'ghost']);
      expect(result.map(p => p.discord_id)).toEqual(['real']);
    });
  });

  // ---- P0-3 --------------------------------------------------------------

  describe('concurrent vote handling', () => {
    const makeMatch = () =>
      createMatch({
        guild_id: 'g1',
        channel_id: 'c1',
        state: 'IN_PROGRESS',
        blue_team: ['p1', 'p2', 'p3'],
        orange_team: ['p4', 'p5', 'p6'],
      });

    it('keeps every report vote when players click at the same time', () => {
      const m = makeMatch();

      // Six players hammering the same button in one tick.
      for (const id of ['p1', 'p2', 'p3', 'p4']) {
        mutateMatchReportStatus(m.match_id, status => {
          status.blueVotes = status.blueVotes!.filter(v => v !== id);
          status.blueVotes.push(id);
        });
      }

      expect(getMatch(m.match_id)!.report_status.blueVotes).toEqual(['p1', 'p2', 'p3', 'p4']);
    });

    it('lets a player switch their vote without duplicating it', () => {
      const m = makeMatch();

      mutateMatchReportStatus(m.match_id, s => s.blueVotes!.push('p1'));
      mutateMatchReportStatus(m.match_id, s => {
        s.blueVotes = s.blueVotes!.filter(v => v !== 'p1');
        s.orangeVotes!.push('p1');
      });

      const final = getMatch(m.match_id)!;
      expect(final.report_status.blueVotes).toEqual([]);
      expect(final.report_status.orangeVotes).toEqual(['p1']);
    });

    it('keeps every gamble agreement so 6/6 is reachable', () => {
      const m = makeMatch();

      for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
        mutateMatchGambleStatus(m.match_id, s => {
          if (!s.agreedPlayers.includes(id)) s.agreedPlayers.push(id);
        });
      }

      expect(getMatch(m.match_id)!.gamble_status!.agreedPlayers).toHaveLength(6);
    });

    it('keeps every queue vote', () => {
      saveQueue({
        channel_id: 'match_chan',
        guild_id: 'g1',
        player_ids: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
        state: 'VOTING',
        vote_counts: { captains: [], balanced: [], random: [] },
      });

      for (const id of ['p1', 'p2', 'p3', 'p4']) {
        mutateQueue('match_chan', q => q.vote_counts.captains.push(id));
      }

      expect(getQueue('match_chan')!.vote_counts.captains).toEqual(['p1', 'p2', 'p3', 'p4']);
    });

    it('returns undefined instead of throwing when the match is gone', () => {
      expect(mutateMatchReportStatus(999999, () => {})).toBeUndefined();
      expect(mutateQueue('no_such_channel', () => {})).toBeUndefined();
    });
  });

  // ---- P0-2 --------------------------------------------------------------

  describe('cancelling a match does not destroy the rank queue', () => {
    it('leaves the persistent rank queue intact when a READY_CHECK match is cancelled', async () => {
      // The persistent panel/queue for the rank channel, with people waiting in it.
      saveQueue({
        channel_id: 'RANK_QUEUE',
        guild_id: 'g1',
        message_id: 'panel_msg_1',
        player_ids: ['waiting_1', 'waiting_2'],
        state: 'WAITING',
        vote_counts: {},
      });

      const match = createMatch({
        guild_id: 'g1',
        channel_id: 'RANK_QUEUE',
        queue_channel_id: 'RANK_QUEUE',
        text_channel_id: 'MATCH_CHAN',
        state: 'READY_CHECK',
        blue_team: ['a', 'b', 'c', 'd', 'e', 'f'],
        orange_team: [],
      });

      // The temporary per-match queue row.
      saveQueue({
        channel_id: 'MATCH_CHAN',
        guild_id: 'g1',
        player_ids: ['a', 'b', 'c', 'd', 'e', 'f'],
        state: 'READY_CHECK',
        vote_counts: {},
      });

      await cancelMatch(fakeClient, match.match_id, 'test');

      const rankQueue = getQueue('RANK_QUEUE');
      expect(rankQueue).toBeDefined();
      expect(rankQueue!.message_id).toBe('panel_msg_1');
      expect(rankQueue!.player_ids).toEqual(['waiting_1', 'waiting_2']);

      // ...while the temporary match queue is cleaned up.
      expect(getQueue('MATCH_CHAN')).toBeUndefined();
    });
  });

  // ---- P0-5 --------------------------------------------------------------

  describe('stale match sweep', () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

    it('cancels an IN_PROGRESS match left running past the timeout', async () => {
      const m = createMatch({
        guild_id: 'g1',
        channel_id: 'c1',
        state: 'IN_PROGRESS',
        blue_team: ['p1'],
        orange_team: ['p2'],
        started_at: hoursAgo(config.matchTimeoutHours + 1),
      });

      await sweepStaleMatches(fakeClient);

      expect(getMatch(m.match_id)!.state).toBe('CANCELLED');
    });

    it('leaves a match that is still within the timeout alone', async () => {
      const m = createMatch({
        guild_id: 'g1',
        channel_id: 'c1',
        state: 'IN_PROGRESS',
        blue_team: ['p1'],
        orange_team: ['p2'],
        started_at: hoursAgo(1),
      });

      await sweepStaleMatches(fakeClient);

      expect(getMatch(m.match_id)!.state).toBe('IN_PROGRESS');
    });

    it('cancels a match stuck mid-setup so its players are released', async () => {
      const m = createMatch({
        guild_id: 'g1',
        channel_id: 'c1',
        state: 'DRAFTING',
        blue_team: ['p1'],
        orange_team: ['p2'],
      });
      // A setup phase should never outlive setupTimeoutMinutes.
      db.prepare('UPDATE matches SET created_at = ? WHERE match_id = ?').run(
        hoursAgo(1),
        m.match_id
      );

      await sweepStaleMatches(fakeClient);

      expect(getMatch(m.match_id)!.state).toBe('CANCELLED');
      expect(getAllLiveMatches()).toHaveLength(0);
    });
  });
});
