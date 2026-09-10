import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import {
  ActiveQueue,
  createMatch,
  updateMatch,
  getActiveMatches,
  getActiveMatchForPlayer,
  getOrCreatePlayer,
  getQueue,
  saveQueue,
} from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import {
  startReadyCheckPhase,
  returnPlayersToQueue,
  handleReadyCheckLeave,
} from '../src/services/readyCheckService';
import { removePlayersFromWaitingQueues } from '../src/services/queuePanel';

const G = 'guild_ready_check_test';
const SIX = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];

/**
 * Every channel lookup misses, so nothing is sent; the DB effects are what we assert.
 *
 * `guilds.fetch` returning null sends startReadyCheckPhase down its no-guild fallback into
 * startVotingPhase, which creates the match row and then throws at createMatchChannels
 * ("Guild ... not found"). The pop has happened by then as far as the database is
 * concerned, so callers below catch and look at the rows.
 */
const fakeClient = {
  channels: { fetch: async () => null },
  guilds: { fetch: async () => null },
  users: { fetch: async () => null },
  user: { id: 'bot_1' },
} as any;

function waitingQueue(channelId: string, playerIds: string[], teamSize = 3): ActiveQueue {
  const queue: ActiveQueue = {
    channel_id: channelId,
    guild_id: G,
    team_size: teamSize,
    player_ids: [...playerIds],
    player_join_times: Object.fromEntries(playerIds.map((id, i) => [id, 1_000 + i])),
    state: 'WAITING',
    vote_counts: {},
  };
  saveQueue(queue);
  return queue;
}

/** A match that is under way somewhere else, holding `id`. */
function liveMatchHolding(id: string) {
  return createMatch({
    guild_id: G,
    channel_id: 'chan_elsewhere',
    team_size: 3,
    state: 'IN_PROGRESS',
    blue_team: [id, 'x1', 'x2'],
    orange_team: ['x3', 'x4', 'x5'],
    rl_name: '',
    rl_pass: '',
  });
}

async function pop(channelId: string, lobby: ActiveQueue): Promise<void> {
  await startReadyCheckPhase(fakeClient, channelId, G, lobby).catch(() => null);
}

beforeEach(() => {
  db.exec(
    'DELETE FROM season_snapshots; DELETE FROM player_ladders; DELETE FROM players; DELETE FROM matches; DELETE FROM active_queues; DELETE FROM bans; DELETE FROM seasons; DELETE FROM guild_divisions; DELETE FROM guild_config;'
  );
  seedGuildDefaults(db, G);
  for (const id of [...SIX, 'p7', 'p8', 'x1']) getOrCreatePlayer(G, 3, id, `User_${id}`);
});

describe('a pop takes its roster out of every other waiting queue', () => {
  // The reported bug: p3 sat in the 3v3 and 2v2 queues, the 3v3 popped, the 2v2 still
  // held p3 and popped later -- one player, two live matches.
  it('removes the popped players from the other queue and leaves the rest of it intact', async () => {
    waitingQueue('chan_3v3', SIX);
    waitingQueue('chan_2v2', ['p3', 'x1', 'p5'], 2);

    await pop('chan_3v3', getQueue('chan_3v3')!);

    expect(getActiveMatchForPlayer(G, 'p3')).toBeDefined();
    const other = getQueue('chan_2v2')!;
    expect(other.player_ids).toEqual(['x1']);
    expect(other.player_join_times).toEqual({ x1: 1_001 });
    expect(other.state).toBe('WAITING');
    expect(other.team_size).toBe(2);
  });

  it('does not touch a queue that has already popped', async () => {
    waitingQueue('chan_3v3', SIX);
    saveQueue({ ...waitingQueue('chan_live', ['p3', 'x1'], 2), state: 'READY_CHECK' });

    await pop('chan_3v3', getQueue('chan_3v3')!);

    expect(getQueue('chan_live')!.player_ids).toEqual(['p3', 'x1']);
  });

  it('leaves the popping queue itself alone', async () => {
    waitingQueue('chan_3v3', SIX);
    waitingQueue('chan_2v2', ['p3'], 2);

    const affected = await removePlayersFromWaitingQueues(fakeClient, G, SIX, 'chan_3v3');

    expect(affected).toEqual(['chan_2v2']);
    expect(getQueue('chan_3v3')!.player_ids).toEqual(SIX);
  });
});

describe('a queue never pops with a player who is already in a live match', () => {
  it('drops them from the row and does not pop', async () => {
    const elsewhere = liveMatchHolding('p1');
    waitingQueue('chan_3v3', SIX);

    await expect(startReadyCheckPhase(fakeClient, 'chan_3v3', G, getQueue('chan_3v3')!)).resolves.toBeUndefined();

    expect(getQueue('chan_3v3')!.player_ids).toEqual(['p2', 'p3', 'p4', 'p5', 'p6']);
    expect(getQueue('chan_3v3')!.player_join_times).not.toHaveProperty('p1');
    expect(getActiveMatches(G).map(m => m.match_id)).toEqual([elsewhere.match_id]);
    expect(getActiveMatchForPlayer(G, 'p2')).toBeUndefined();
  });

  // A re-pop hands over a lobby that has already been sliced off the front of the row,
  // with the row holding whoever is waiting behind. The gap has to be filled from there.
  it('fills the gap from the players waiting behind the lobby', async () => {
    liveMatchHolding('p1');
    const lobby: ActiveQueue = {
      ...waitingQueue('chan_3v3', ['p7', 'p8']),
      player_ids: [...SIX],
      player_join_times: Object.fromEntries(SIX.map((id, i) => [id, 100 + i])),
    };

    await pop('chan_3v3', lobby);

    // The row itself is not asserted: the no-guild fallback saves the lobby over it on
    // its way to voting, so with the fake client it does not survive to be read.
    const next = getActiveMatchForPlayer(G, 'p7')!;
    expect(next.blue_team).toEqual(['p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(getActiveMatchForPlayer(G, 'p8')).toBeUndefined();
  });

  it('puts a lobby that came up short back into the row, ahead of anyone waiting', async () => {
    liveMatchHolding('p1');
    liveMatchHolding('p2');
    const lobby: ActiveQueue = {
      ...waitingQueue('chan_3v3', ['p7']),
      player_ids: [...SIX],
      player_join_times: Object.fromEntries(SIX.map((id, i) => [id, 100 + i])),
    };

    await pop('chan_3v3', lobby);

    expect(getActiveMatchForPlayer(G, 'p3')).toBeUndefined();
    const row = getQueue('chan_3v3')!;
    expect(row.player_ids).toEqual(['p3', 'p4', 'p5', 'p6', 'p7']);
    expect(row.player_join_times).toEqual({ p3: 102, p4: 103, p5: 104, p6: 105, p7: 1_000 });
  });

  it('lets test bots pop while a bot lobby runs elsewhere', async () => {
    createMatch({
      guild_id: G,
      channel_id: 'chan_2v2',
      team_size: 2,
      state: 'VOTING',
      blue_team: ['test_bot_1', 'test_bot_2', 'test_bot_3', 'test_bot_4'],
      orange_team: [],
      rl_name: '',
      rl_pass: '',
    });
    const bots = ['test_bot_1', 'test_bot_2', 'test_bot_3', 'test_bot_4', 'test_bot_5', 'test_bot_6'];
    for (const id of bots) getOrCreatePlayer(G, 3, id, id);
    waitingQueue('chan_3v3', bots);

    await pop('chan_3v3', getQueue('chan_3v3')!);

    expect(getActiveMatches(G)).toHaveLength(2);
  });
});

describe('a failed ready check returns the players who showed up', () => {
  /** The check's own match, already cancelled -- which is what the fail path does first. */
  function cancelledCheck(roster: string[]) {
    const m = createMatch({
      guild_id: G,
      channel_id: 'chan_3v3',
      team_size: 3,
      queue_channel_id: 'chan_3v3',
      state: 'READY_CHECK',
      blue_team: roster,
      orange_team: [],
      rl_name: '',
      rl_pass: '',
    });
    updateMatch(m.match_id, { state: 'CANCELLED', winner: 'NONE', completed_at: new Date().toISOString() });
    return m;
  }
  const joinTimes = Object.fromEntries(SIX.map((id, i) => [id, 100 + i]));
  const allBut = (leaver: string) => SIX.filter(id => id !== leaver);

  it('does not return the leaver', async () => {
    cancelledCheck(SIX);
    waitingQueue('chan_3v3', []);

    const res = await returnPlayersToQueue(fakeClient, 'chan_3v3', G, allBut('p4'), joinTimes);

    expect(res).toEqual({ rePopped: false, waiting: 5 });
    const row = getQueue('chan_3v3')!;
    expect(row.player_ids).toEqual(['p1', 'p2', 'p3', 'p5', 'p6']);
    expect(row.player_join_times).toEqual({ p1: 100, p2: 101, p3: 102, p5: 104, p6: 105 });
    expect(row.state).toBe('WAITING');
  });

  it('puts them ahead of anyone who joined while the check ran', async () => {
    cancelledCheck(SIX);
    waitingQueue('chan_3v3', ['p7']);

    const res = await returnPlayersToQueue(fakeClient, 'chan_3v3', G, ['p1', 'p2', 'p3', 'p5'], joinTimes);

    expect(res).toEqual({ rePopped: false, waiting: 5 });
    const row = getQueue('chan_3v3')!;
    expect(row.player_ids).toEqual(['p1', 'p2', 'p3', 'p5', 'p7']);
    expect(row.player_join_times!.p7).toBe(1_000);
  });

  it('re-pops when the returning players and the waiting ones make a full lobby', async () => {
    const failed = cancelledCheck(SIX);
    waitingQueue('chan_3v3', ['p7', 'p8']);

    const res = await returnPlayersToQueue(fakeClient, 'chan_3v3', G, allBut('p4'), joinTimes);

    expect(res).toEqual({ rePopped: true, waiting: 1 });
    const next = getActiveMatchForPlayer(G, 'p7')!;
    expect(next.match_id).not.toBe(failed.match_id);
    expect(next.blue_team).toEqual(['p1', 'p2', 'p3', 'p5', 'p6', 'p7']);
    expect(getActiveMatchForPlayer(G, 'p4')).toBeUndefined();
    expect(getActiveMatchForPlayer(G, 'p8')).toBeUndefined();
  });

  it('refuses the Not-ready button when no check is registered for the match', async () => {
    const res = await handleReadyCheckLeave(4242, 'p1');
    expect(res.success).toBe(false);
  });
});
