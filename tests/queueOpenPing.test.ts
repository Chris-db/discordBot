import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import db from '../src/database/db';
import { updateDivision, getQueue } from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import {
  handleJoinQueue,
  handleLeaveQueue,
  getOrInitQueue,
  QUEUE_OPEN_PING_COOLDOWN_MS,
} from '../src/services/queuePanel';

const G = 'guild_ping_test';
const CHAN = 'ping_rank_c';
const ROLE = 'role_rank_c';

const user = (id: string) => ({ id, username: id }) as any;

/**
 * A client with one channel that records everything sent to it. The panel refresh goes
 * through the same `send`, so the recording also shows which message landed first.
 */
function clientRecordingSends() {
  const sends: any[] = [];
  const channel = {
    id: CHAN,
    lastMessageId: null as string | null,
    send: async (payload: any) => {
      sends.push(payload);
      return { id: `msg_${sends.length}` };
    },
    messages: { edit: async () => null, delete: async () => null },
  };
  const client = {
    channels: { fetch: async () => channel },
    users: { fetch: async () => null },
    user: { id: 'bot_1' },
  } as any;
  return { client, sends };
}

const pings = (sends: any[]) => sends.filter(s => typeof s.content === 'string' && s.content.includes('<@&'));

// The cooldown is keyed on wall-clock time; every test starts a fresh 10 minutes later so
// none inherits the previous test's ping.
let clock = Date.now();
vi.useFakeTimers({ toFake: ['Date'] });
afterAll(() => vi.useRealTimers());

describe('first join pings the division role', () => {
  beforeEach(() => {
    clock += 10 * 60 * 1000;
    vi.setSystemTime(clock);
    db.exec(
      `DELETE FROM active_queues WHERE guild_id = '${G}'; DELETE FROM guild_divisions WHERE guild_id = '${G}';
       DELETE FROM player_ladders WHERE guild_id = '${G}'; DELETE FROM players WHERE guild_id = '${G}';`
    );
    seedGuildDefaults(db, G);
    updateDivision(G, 3, 'C', { queue_channel_id: CHAN, role_id: ROLE });
    getOrInitQueue(CHAN, G);
  });

  it('pings the role, names the player, and lets only the role mention', async () => {
    const { client, sends } = clientRecordingSends();

    const res = await handleJoinQueue(client, CHAN, G, user('first'));
    await res.settled;

    expect(res.success).toBe(true);
    const [ping] = pings(sends);
    expect(ping).toBeDefined();
    expect(ping.content).toContain(`<@&${ROLE}>`);
    expect(ping.content).toContain('<@first>');
    expect(ping.content).toContain('1/6');
    expect(ping.allowedMentions).toEqual({ roles: [ROLE] });
  });

  it('posts the ping before the panel so the panel ends up underneath', async () => {
    const { client, sends } = clientRecordingSends();

    const res = await handleJoinQueue(client, CHAN, G, user('first'));
    await res.settled;

    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(sends[0].content).toContain(`<@&${ROLE}>`);
    expect(sends[1].files).toBeDefined();
    expect(getQueue(CHAN)!.message_id).toBe('msg_2');
  });

  it('does not ping for the second player', async () => {
    const { client, sends } = clientRecordingSends();

    await (await handleJoinQueue(client, CHAN, G, user('first'))).settled;
    await (await handleJoinQueue(client, CHAN, G, user('second'))).settled;

    expect(pings(sends)).toHaveLength(1);
    expect(getQueue(CHAN)!.player_ids).toEqual(['first', 'second']);
  });

  it('stays quiet when the division has no role', async () => {
    updateDivision(G, 3, 'C', { role_id: null as any });
    const { client, sends } = clientRecordingSends();

    await (await handleJoinQueue(client, CHAN, G, user('first'))).settled;

    expect(pings(sends)).toHaveLength(0);
    expect(getQueue(CHAN)!.player_ids).toEqual(['first']);
  });

  it('stays quiet in a channel no division is registered to', async () => {
    getOrInitQueue('ping_scratch', G);
    const { client, sends } = clientRecordingSends();

    await (await handleJoinQueue(client, 'ping_scratch', G, user('first'))).settled;

    expect(pings(sends)).toHaveLength(0);
  });

  it('does not ping again for a leave-and-rejoin inside the cooldown', async () => {
    const { client, sends } = clientRecordingSends();

    await (await handleJoinQueue(client, CHAN, G, user('first'))).settled;
    await (await handleLeaveQueue(client, CHAN, user('first'))).settled;
    await (await handleJoinQueue(client, CHAN, G, user('first'))).settled;

    expect(pings(sends)).toHaveLength(1);
  });

  it('pings again once the cooldown has passed', async () => {
    const { client, sends } = clientRecordingSends();

    await (await handleJoinQueue(client, CHAN, G, user('first'))).settled;
    await (await handleLeaveQueue(client, CHAN, user('first'))).settled;

    clock += QUEUE_OPEN_PING_COOLDOWN_MS;
    vi.setSystemTime(clock);
    await (await handleJoinQueue(client, CHAN, G, user('first'))).settled;

    expect(pings(sends)).toHaveLength(2);
  });

  it('a failed ping does not stop the join or the panel', async () => {
    const { client, sends } = clientRecordingSends();
    const channel = await client.channels.fetch(CHAN);
    let calls = 0;
    channel.send = async (payload: any) => {
      calls += 1;
      if (calls === 1) throw new Error('Missing Permissions');
      sends.push(payload);
      return { id: `msg_${sends.length}` };
    };

    const res = await handleJoinQueue(client, CHAN, G, user('first'));
    await res.settled;

    expect(res.success).toBe(true);
    expect(pings(sends)).toHaveLength(0);
    expect(sends.some(s => s.files)).toBe(true);
    expect(getQueue(CHAN)!.player_ids).toEqual(['first']);
  });
});
