import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import { createMatch, getMatch, updateMatch } from '../src/database/queries';
import { cleanupMatch } from '../src/services/matchService';

/** Minimal stand-in for a discord.js Client: every lookup misses, nothing is sent. */
const fakeClient = {
  channels: { fetch: async () => null },
  guilds: { fetch: async () => null },
  users: { fetch: async () => null },
  user: { id: 'bot_1' },
} as any;

const makeMatch = () =>
  createMatch({
    guild_id: 'g1',
    channel_id: 'c1',
    state: 'IN_PROGRESS',
    blue_team: ['p1', 'p2', 'p3'],
    orange_team: ['p4', 'p5', 'p6'],
  });

describe('/match cleanup match:N', () => {
  beforeEach(() => {
    db.exec('DELETE FROM player_ladders; DELETE FROM players; DELETE FROM active_queues; DELETE FROM matches; DELETE FROM bans;');
  });

  it('leaves a finished match and its winner alone', async () => {
    const m = makeMatch();
    const completedAt = '2026-11-01T12:00:00.000Z';
    updateMatch(m.match_id, { state: 'COMPLETED', winner: 'BLUE', completed_at: completedAt });

    const res = await cleanupMatch(fakeClient, m.match_id);

    const after = getMatch(m.match_id)!;
    expect(res.cancelled).toBe(false);
    expect(after.state).toBe('COMPLETED');
    expect(after.winner).toBe('BLUE');
    expect(after.completed_at).toBe(completedAt);
  });

  it('cancels a match that is still live', async () => {
    const m = makeMatch();

    const res = await cleanupMatch(fakeClient, m.match_id);

    const after = getMatch(m.match_id)!;
    expect(res.cancelled).toBe(true);
    expect(after.state).toBe('CANCELLED');
    expect(after.winner).toBe('NONE');
  });
});
