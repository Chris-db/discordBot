import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import {
  createMatch,
  getMatch,
  updateMatch,
  getMatchesBySeries,
  getSeriesScore,
  getOrInitQueueRow,
  getQueue,
  getOrCreatePlayer,
  createBan,
  saveQueue,
} from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import { handleRematchVote, startRematch, summariseSeries, handleRequeue } from '../src/services/rematchService';
import { votesRequiredFor } from '../src/services/gameRules';

const G = 'guild_rematch_test';
const BLUE = ['b1', 'b2', 'b3'];
const ORANGE = ['o1', 'o2', 'o3'];
const ROSTER = [...BLUE, ...ORANGE];

/** Every channel lookup misses, so nothing is sent; the DB effects are what we assert. */
const fakeClient = {
  channels: { fetch: async () => null },
  guilds: { fetch: async () => null },
  users: { fetch: async () => null },
  user: { id: 'bot_1' },
} as any;

function makeCompletedMatch(overrides: Record<string, unknown> = {}) {
  const match = createMatch({
    guild_id: G,
    channel_id: 'queue_chan',
    blue_team: BLUE,
    orange_team: ORANGE,
    rl_name: 'RL42',
    rl_pass: '317',
    text_channel_id: 'match_chan',
    queue_channel_id: 'queue_chan',
    ...overrides,
  });
  updateMatch(match.match_id, { state: 'COMPLETED', winner: 'BLUE', completed_at: new Date().toISOString() });
  return getMatch(match.match_id)!;
}

describe('series score', () => {
  beforeEach(() => {
    db.exec('DELETE FROM matches;');
  });

  /** A completed game in a series, with an explicit winner and position. */
  function seriesGame(seriesId: string, game: number, winner: 'BLUE' | 'ORANGE') {
    const m = createMatch({
      guild_id: G,
      channel_id: 'queue_chan',
      team_size: 3,
      blue_team: BLUE,
      orange_team: ORANGE,
      series_id: seriesId,
      series_game: game,
    });
    updateMatch(m.match_id, {
      state: 'COMPLETED',
      winner,
      completed_at: new Date().toISOString(),
    });
    return m.match_id;
  }

  it('counts wins per side across the series', () => {
    seriesGame('s1', 1, 'BLUE');
    seriesGame('s1', 2, 'ORANGE');
    seriesGame('s1', 3, 'BLUE');

    expect(getSeriesScore('s1')).toEqual({ blueWins: 2, orangeWins: 1, games: 3 });
  });

  it('reports the score as it stood after a given game, not the final one', () => {
    seriesGame('s1', 1, 'BLUE');
    seriesGame('s1', 2, 'ORANGE');
    seriesGame('s1', 3, 'BLUE');

    // This is the whole point for /history: game 1's row must not show 2-1.
    expect(getSeriesScore('s1', 1)).toEqual({ blueWins: 1, orangeWins: 0, games: 1 });
    expect(getSeriesScore('s1', 2)).toEqual({ blueWins: 1, orangeWins: 1, games: 2 });
    expect(getSeriesScore('s1', 3)).toEqual({ blueWins: 2, orangeWins: 1, games: 3 });
  });

  it('ignores games that were cancelled or are still running', () => {
    seriesGame('s1', 1, 'BLUE');
    const live = createMatch({
      guild_id: G,
      channel_id: 'queue_chan',
      team_size: 3,
      blue_team: BLUE,
      orange_team: ORANGE,
      series_id: 's1',
      series_game: 2,
    });
    expect(getSeriesScore('s1')).toEqual({ blueWins: 1, orangeWins: 0, games: 1 });

    updateMatch(live.match_id, { state: 'CANCELLED', completed_at: new Date().toISOString() });
    expect(getSeriesScore('s1')).toEqual({ blueWins: 1, orangeWins: 0, games: 1 });
  });

  it('does not bleed between series', () => {
    seriesGame('s1', 1, 'BLUE');
    seriesGame('s2', 1, 'ORANGE');

    expect(getSeriesScore('s1')).toEqual({ blueWins: 1, orangeWins: 0, games: 1 });
    expect(getSeriesScore('s2')).toEqual({ blueWins: 0, orangeWins: 1, games: 1 });
  });

  it('is empty for a series that has not finished a game', () => {
    expect(getSeriesScore('nonexistent')).toEqual({ blueWins: 0, orangeWins: 0, games: 0 });
    expect(summariseSeries('nonexistent')).toBe('');
  });
});

describe('rematch', () => {
  beforeEach(() => {
    db.exec('DELETE FROM season_snapshots; DELETE FROM player_ladders; DELETE FROM players; DELETE FROM matches; DELETE FROM active_queues; DELETE FROM bans; DELETE FROM seasons; DELETE FROM guild_divisions; DELETE FROM guild_config;');
    seedGuildDefaults(db, G);
    for (const id of ROSTER) getOrCreatePlayer(G, 3, id, `User_${id}`);
  });

  describe('voting', () => {
    it('needs a majority of the humans in the lobby', () => {
      expect(votesRequiredFor(ROSTER)).toBe(4);
      // A lobby padded with test bots must not need votes the bots will never cast --
      // the same trap the gamble flow fell into by requiring all 6.
      expect(votesRequiredFor(['b1', 'test_bot_1', 'test_bot_2'])).toBe(1);
      expect(votesRequiredFor(['b1', 'b2', 'test_bot_1'])).toBe(2);
    });

    it('records a vote and does not start a rematch below the threshold', async () => {
      const match = makeCompletedMatch();

      await handleRematchVote(fakeClient, match.match_id, 'b1', 'yes');
      await handleRematchVote(fakeClient, match.match_id, 'b2', 'yes');

      expect(getMatch(match.match_id)!.report_status.rematchVotes).toEqual(['b1', 'b2']);
      expect(getMatch(match.match_id)!.report_status.rematchResolved).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) n FROM matches').get()).toEqual({ n: 1 });
    });

    it('accumulates votes from several players rather than overwriting', async () => {
      const match = makeCompletedMatch();

      // Note: this does not prove serialisation. Below the threshold the handler has no
      // await between reading and writing, so Promise.all runs these one after another
      // regardless. The protection against the lost-vote race is that the read and write
      // happen inside mutateMatchReportStatus's transaction; that is covered directly in
      // regressions.test.ts. What this pins is that each vote is appended, not replaced.
      await Promise.all([
        handleRematchVote(fakeClient, match.match_id, 'b1', 'yes'),
        handleRematchVote(fakeClient, match.match_id, 'b2', 'yes'),
        handleRematchVote(fakeClient, match.match_id, 'b3', 'yes'),
      ]);

      expect(getMatch(match.match_id)!.report_status.rematchVotes!.sort()).toEqual(['b1', 'b2', 'b3']);
    });

    it('lets a player change their mind without double-counting', async () => {
      const match = makeCompletedMatch();

      await handleRematchVote(fakeClient, match.match_id, 'b1', 'yes');
      await handleRematchVote(fakeClient, match.match_id, 'b1', 'no');

      const status = getMatch(match.match_id)!.report_status;
      expect(status.rematchVotes).toEqual([]);
      expect(status.rematchDeclines).toEqual(['b1']);
    });

    it('rejects votes from outside the match', async () => {
      const match = makeCompletedMatch();
      const res = await handleRematchVote(fakeClient, match.match_id, 'stranger', 'yes');

      expect(res.success).toBe(false);
      expect(res.message).toMatch(/Only players from this match/);
      expect(getMatch(match.match_id)!.report_status.rematchVotes).toBeUndefined();
    });

    it('rejects votes on a match that is still running', async () => {
      const match = createMatch({
        guild_id: G,
        channel_id: 'queue_chan',
        blue_team: BLUE,
        orange_team: ORANGE,
      });
      const res = await handleRematchVote(fakeClient, match.match_id, 'b1', 'yes');
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/not finished/);
    });

    it('closes the vote once too many players have declined', async () => {
      const match = makeCompletedMatch();

      // 4 needed to pass out of 6, so 3 declines make it unreachable.
      for (const id of ['b1', 'b2', 'b3']) {
        await handleRematchVote(fakeClient, match.match_id, id, 'no');
      }

      expect(getMatch(match.match_id)!.report_status.rematchResolved).toBe(true);
      const after = await handleRematchVote(fakeClient, match.match_id, 'o1', 'yes');
      expect(after.success).toBe(false);
      expect(after.message).toMatch(/already been decided/);
    });

    it('starts the rematch once the threshold is reached', async () => {
      const match = makeCompletedMatch();

      for (const id of ['b1', 'b2', 'b3', 'o1']) {
        await handleRematchVote(fakeClient, match.match_id, id, 'yes');
      }

      const all = db.prepare('SELECT * FROM matches ORDER BY match_id').all() as any[];
      expect(all.length).toBe(2);
      expect(getMatch(match.match_id)!.report_status.rematchResolved).toBe(true);
    });
  });

  describe('startRematch', () => {
    it('creates a new match with the same teams and channels', async () => {
      const first = makeCompletedMatch();
      const second = (await startRematch(fakeClient, first.match_id))!;

      expect(second.match_id).not.toBe(first.match_id);
      expect(second.blue_team).toEqual(BLUE);
      expect(second.orange_team).toEqual(ORANGE);
      expect(second.text_channel_id).toBe('match_chan');
      expect(second.queue_channel_id).toBe('queue_chan');
      expect(second.state).toBe('IN_PROGRESS');
    });

    it('issues fresh lobby credentials', async () => {
      const first = makeCompletedMatch();
      const second = (await startRematch(fakeClient, first.match_id))!;
      expect(second.rl_name).toBeTruthy();
      expect(second.rl_pass).toMatch(/^\d{3}$/);
    });

    it('leaves the previous match result intact', async () => {
      const first = makeCompletedMatch();
      await startRematch(fakeClient, first.match_id);

      const previous = getMatch(first.match_id)!;
      expect(previous.state).toBe('COMPLETED');
      expect(previous.winner).toBe('BLUE');
    });

    it('numbers the series and backfills game 1', async () => {
      const first = makeCompletedMatch();
      const second = (await startRematch(fakeClient, first.match_id))!;

      expect(getMatch(first.match_id)!.series_game).toBe(1);
      expect(second.series_game).toBe(2);
      expect(second.series_id).toBe(getMatch(first.match_id)!.series_id);
      expect(second.series_id).toBeTruthy();
    });

    it('keeps extending the same series across several rematches', async () => {
      let current = makeCompletedMatch();
      const seriesIds = new Set<string>();

      for (let game = 2; game <= 4; game++) {
        const next = (await startRematch(fakeClient, current.match_id))!;
        expect(next.series_game).toBe(game);
        seriesIds.add(next.series_id!);
        updateMatch(next.match_id, { state: 'COMPLETED', winner: 'ORANGE' });
        current = getMatch(next.match_id)!;
      }

      expect(seriesIds.size).toBe(1);
      expect(getMatchesBySeries([...seriesIds][0]).length).toBe(4);
    });

    it('refuses to launch twice from the same match', async () => {
      const first = makeCompletedMatch();
      await startRematch(fakeClient, first.match_id);
      const duplicate = await startRematch(fakeClient, first.match_id);

      expect(duplicate).toBeUndefined();
      expect((db.prepare('SELECT COUNT(*) n FROM matches').get() as any).n).toBe(2);
    });

    it('carries the division forward', async () => {
      const first = makeCompletedMatch({ division: 'A' });
      const second = (await startRematch(fakeClient, first.match_id))!;
      expect(second.division).toBe('A');
    });
  });

  describe('summariseSeries', () => {
    it('counts only completed games', async () => {
      let current = makeCompletedMatch();
      const second = (await startRematch(fakeClient, current.match_id))!;
      updateMatch(second.match_id, { state: 'COMPLETED', winner: 'ORANGE' });
      const third = (await startRematch(fakeClient, second.match_id))!;

      // first BLUE, second ORANGE, third still in progress.
      const summary = summariseSeries(third.series_id!);
      expect(summary).toContain('1 — 1');
    });

    it('is empty for a series with nothing completed', () => {
      expect(summariseSeries('series-that-does-not-exist')).toBe('');
    });
  });

  describe('requeue', () => {
    it('puts the whole lobby back into the queue channel', async () => {
      const match = makeCompletedMatch();
      const res = await handleRequeue(fakeClient, match.match_id, 'b1');

      expect(res.success).toBe(true);
      expect(getQueue('queue_chan')!.player_ids.sort()).toEqual([...ROSTER].sort());
    });

    it('skips banned players rather than failing the batch', async () => {
      createBan(G, 'o3', 'admin', 'being rude', null);
      const match = makeCompletedMatch();

      await handleRequeue(fakeClient, match.match_id, 'b1');

      const queued = getQueue('queue_chan')!.player_ids;
      expect(queued).not.toContain('o3');
      expect(queued.length).toBe(5);
    });

    it('does not add anyone to a queue that has already popped', async () => {
      saveQueue({
        channel_id: 'queue_chan',
        guild_id: G,
        player_ids: ['someone_else'],
        player_join_times: {},
        state: 'READY_CHECK',
        vote_counts: {},
      } as any);
      const match = makeCompletedMatch();

      const res = await handleRequeue(fakeClient, match.match_id, 'b1');

      expect(res.success).toBe(false);
      expect(getQueue('queue_chan')!.player_ids).toEqual(['someone_else']);
    });

    it('does not duplicate a player already waiting', async () => {
      getOrInitQueueRow('queue_chan', G, 3, ['b1']);
      const match = makeCompletedMatch();

      await handleRequeue(fakeClient, match.match_id, 'b2');

      const queued = getQueue('queue_chan')!.player_ids;
      expect(queued.filter(id => id === 'b1').length).toBe(1);
      expect(queued.length).toBe(6);
    });

    it('rejects a requeue from someone who was not in the match', async () => {
      const match = makeCompletedMatch();
      const res = await handleRequeue(fakeClient, match.match_id, 'stranger');
      expect(res.success).toBe(false);
    });
  });
});

describe('updateMatch dynamic SET', () => {
  beforeEach(() => {
    db.exec('DELETE FROM matches; DELETE FROM seasons; DELETE FROM guild_divisions; DELETE FROM guild_config;');
    seedGuildDefaults(db, G);
  });

  const base = () =>
    createMatch({
      guild_id: G,
      channel_id: 'c1',
      blue_team: BLUE,
      orange_team: ORANGE,
      rl_name: 'RL42',
      rl_pass: '317',
      text_channel_id: 'tc',
    });

  it('leaves untouched columns alone', () => {
    const match = base();
    updateMatch(match.match_id, { winner: 'BLUE' });

    const after = getMatch(match.match_id)!;
    expect(after.winner).toBe('BLUE');
    expect(after.rl_name).toBe('RL42');
    expect(after.rl_pass).toBe('317');
    expect(after.text_channel_id).toBe('tc');
    expect(after.blue_team).toEqual(BLUE);
  });

  it('round-trips the JSON columns', () => {
    const match = base();
    updateMatch(match.match_id, {
      report_status: { blueVotes: ['b1'], rematchVotes: ['b2'] },
      blue_team: ['x1', 'x2', 'x3'],
    });

    const after = getMatch(match.match_id)!;
    expect(after.report_status.blueVotes).toEqual(['b1']);
    expect(after.report_status.rematchVotes).toEqual(['b2']);
    expect(after.blue_team).toEqual(['x1', 'x2', 'x3']);
  });

  it('treats an empty string as clearing a column', () => {
    const match = base();
    updateMatch(match.match_id, { ready_check_vc_id: 'vc_1' });
    expect(getMatch(match.match_id)!.ready_check_vc_id).toBe('vc_1');

    updateMatch(match.match_id, { ready_check_vc_id: '' });
    expect(getMatch(match.match_id)!.ready_check_vc_id).toBeUndefined();
  });

  it('stamps started_at exactly once, on the first move to IN_PROGRESS', () => {
    const match = createMatch({
      guild_id: G,
      channel_id: 'c1',
      state: 'READY_CHECK',
      blue_team: BLUE,
      orange_team: ORANGE,
    });
    expect(getMatch(match.match_id)!.started_at).toBeUndefined();

    updateMatch(match.match_id, { state: 'IN_PROGRESS' });
    const stamped = getMatch(match.match_id)!.started_at;
    expect(stamped).toBeTruthy();

    // Match duration depends on this not moving on later updates.
    updateMatch(match.match_id, { state: 'IN_PROGRESS' });
    updateMatch(match.match_id, { winner: 'BLUE' });
    expect(getMatch(match.match_id)!.started_at).toBe(stamped);
  });

  it('is a no-op when given nothing to change', () => {
    const match = base();
    const after = updateMatch(match.match_id, {});
    expect(after.match_id).toBe(match.match_id);
    expect(after.rl_name).toBe('RL42');
  });

  it('persists the series columns', () => {
    const match = base();
    updateMatch(match.match_id, { series_id: 'series-x', series_game: 3 });

    const after = getMatch(match.match_id)!;
    expect(after.series_id).toBe('series-x');
    expect(after.series_game).toBe(3);
  });
});
