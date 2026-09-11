import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import { getOrCreatePlayer, setPlayerDivision, updateDivision, getQueue } from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import { handleJoinQueue, getOrInitQueue } from '../src/services/queuePanel';

const G = 'guild_gate_test';
const C_CHAN = 'gate_rank_c';
const A_CHAN = 'gate_rank_a';

const fakeClient = {
  channels: { fetch: async () => null },
  guilds: { fetch: async () => null },
  users: { fetch: async () => null },
  user: { id: 'bot_1' },
} as any;

const user = (id: string) => ({ id, username: id }) as any;

describe('a queue channel only admits its own division', () => {
  beforeEach(() => {
    db.exec(
      `DELETE FROM active_queues WHERE guild_id = '${G}'; DELETE FROM guild_divisions WHERE guild_id = '${G}';
       DELETE FROM player_ladders WHERE guild_id = '${G}'; DELETE FROM players WHERE guild_id = '${G}';`
    );
    seedGuildDefaults(db, G);
    updateDivision(G, 3, 'C', { queue_channel_id: C_CHAN });
    updateDivision(G, 3, 'A', { queue_channel_id: A_CHAN });
    getOrInitQueue(C_CHAN, G);
    getOrInitQueue(A_CHAN, G);
  });

  it('turns a Rank C player away from the Rank A queue and points at their own', async () => {
    const res = await handleJoinQueue(fakeClient, A_CHAN, G, user('c_player'));

    expect(res.success).toBe(false);
    expect(res.message).toContain('Rank A');
    expect(res.message).toContain('Rank C');
    expect(res.message).toContain(`<#${C_CHAN}>`);
    expect(getQueue(A_CHAN)!.player_ids).toEqual([]);
  });

  it('lets a placed Rank A player into the Rank A queue', async () => {
    getOrCreatePlayer(G, 3, 'a_player', 'a_player');
    setPlayerDivision(G, 3, 'a_player', 'A');

    const res = await handleJoinQueue(fakeClient, A_CHAN, G, user('a_player'));

    expect(res.success).toBe(true);
    expect(getQueue(A_CHAN)!.player_ids).toEqual(['a_player']);
  });

  it('does not gate an unregistered channel', async () => {
    getOrInitQueue('gate_scratch', G);
    const res = await handleJoinQueue(fakeClient, 'gate_scratch', G, user('anyone'));
    expect(res.success).toBe(true);
  });
});
