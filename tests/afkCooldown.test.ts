import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import { getActiveBan, getActiveBansByGuild } from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import config from '../src/config';
import { applyAfkCooldown, AFK_COOLDOWN_REASON } from '../src/services/readyCheckService';
import { handleJoinQueue, getOrInitQueue } from '../src/services/queuePanel';

const G = 'guild_afk_test';
const CHAN = 'afk_queue_chan';

const fakeClient = {
  channels: { fetch: async () => null },
  guilds: { fetch: async () => null },
  users: { fetch: async () => null },
  user: { id: 'bot_1' },
} as any;

describe('ready-check AFK cooldown', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM bans WHERE guild_id = '${G}'; DELETE FROM active_queues WHERE guild_id = '${G}';`);
    seedGuildDefaults(db, G);
    config.afkCooldownMinutes = 5;
  });

  it('puts each AFK human on a timed cooldown, and skips test bots', () => {
    const cooled = applyAfkCooldown(G, ['afk_1', 'test_bot_2', 'afk_3'], 'bot_1');

    expect(cooled).toEqual(['afk_1', 'afk_3']);
    expect(getActiveBan(G, 'test_bot_2')).toBeNull();

    const ban = getActiveBan(G, 'afk_1')!;
    expect(ban.reason).toBe(AFK_COOLDOWN_REASON);
    const expires = new Date(ban.expires_at!).getTime();
    expect(expires).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it('does nothing when the cooldown is set to zero', () => {
    config.afkCooldownMinutes = 0;
    expect(applyAfkCooldown(G, ['afk_1'], 'bot_1')).toEqual([]);
    expect(getActiveBansByGuild(G)).toEqual([]);
  });

  it('tells a cooled-down player when they can queue again, not that they are banned', async () => {
    applyAfkCooldown(G, ['afk_1'], 'bot_1');
    getOrInitQueue(CHAN, G);

    const res = await handleJoinQueue(fakeClient, CHAN, G, { id: 'afk_1', username: 'afk' } as any);

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/missed the last ready check/i);
    expect(res.message).toMatch(/<t:\d+:R>/);
    expect(res.message).not.toMatch(/banned/i);
  });
});
