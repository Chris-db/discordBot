import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client, Status } from 'discord.js';
import { beat, gatewayConnected, startHeartbeat, FetchLike } from '../src/services/heartbeat';
import { validateConfig, AppConfig } from '../src/config';
import config from '../src/config';
import { logger } from '../src/utils/logger';

/**
 * The uptime heartbeat. What matters is the *absence* of pings: the monitor must never
 * hear from a bot whose gateway is down, and must hear promptly from one that just came up.
 */

const shardsWith = (...statuses: Status[]) => ({ ws: { shards: new Map(statuses.map((status, id) => [id, { status }])) } });
const clientThatIs = (ready: boolean) => shardsWith(ready ? Status.Ready : Status.Connecting);

function recorder(ok = true) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async url => {
    calls.push(url);
    return { ok, status: ok ? 200 : 503 };
  };
  return { calls, fetchImpl };
}

describe('beat', () => {
  it('pings while the gateway is connected', async () => {
    const { calls, fetchImpl } = recorder();
    expect(await beat(clientThatIs(true), 'https://hc-ping.com/abc', fetchImpl)).toBe('sent');
    expect(calls).toEqual(['https://hc-ping.com/abc']);
  });

  it('stays silent while the gateway is down, so the monitor alarms', async () => {
    const { calls, fetchImpl } = recorder();
    expect(await beat(clientThatIs(false), 'https://hc-ping.com/abc', fetchImpl)).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('reports a rejected or non-2xx ping as failed rather than throwing', async () => {
    expect(await beat(clientThatIs(true), 'https://x', recorder(false).fetchImpl)).toBe('failed');
    const throwing: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await beat(clientThatIs(true), 'https://x', throwing)).toBe('failed');
  });
});

describe('gatewayConnected', () => {
  it('needs every shard Ready, and at least one shard', () => {
    expect(gatewayConnected(shardsWith(Status.Ready, Status.Ready))).toBe(true);
    expect(gatewayConnected(shardsWith(Status.Ready, Status.Resuming))).toBe(false);
    expect(gatewayConnected(shardsWith())).toBe(false);
  });

  // The six-week outage. On the Pi the first login fails (WiFi not up yet), discord.js
  // destroys the client, the retry logs in on that same client -- and `isReady()` stays
  // false forever because `ws.destroyed` never resets. Uses a real Client so a future
  // discord.js that changes this shows up here rather than on the monitor.
  it('still pings after a failed login was retried on the same client', async () => {
    const client = new Client({ intents: [] });
    await client.destroy(); // what client.login() does when it throws
    // ...then the retry connects: the manager and its shard come up Ready.
    (client.ws as any).status = Status.Ready;
    client.ws.shards.set(0, { status: Status.Ready } as any);

    expect(client.isReady()).toBe(false); // the latch the heartbeat must not rely on
    const { calls, fetchImpl } = recorder();
    expect(await beat(client, 'https://hc-ping.com/abc', fetchImpl)).toBe('sent');
    expect(calls).toEqual(['https://hc-ping.com/abc']);
  });
});

describe('startHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('says once when it holds pings for a disconnected gateway, and once when it resumes', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const shard = { status: Status.Connecting };
    const client = { ws: { shards: new Map([[0, shard]]) } };
    const { calls, fetchImpl } = recorder();

    const stop = startHeartbeat(client, { url: 'https://hc-ping.com/abc', fetchImpl, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toEqual([]);
    expect(warn.mock.calls.filter(c => String(c[0]).startsWith('Heartbeat paused')).length).toBe(1);

    shard.status = Status.Ready;
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.length).toBe(1);
    expect(info.mock.calls.filter(c => String(c[0]).startsWith('Heartbeat resumed')).length).toBe(1);
    stop();
  });

  it('does nothing at all without a URL', () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = recorder();
    // `url: undefined` falls through to config, which on the Pi is the real .env with a
    // real HEARTBEAT_URL -- so blank it, or this test depends on where it runs.
    const saved = config.heartbeatUrl;
    config.heartbeatUrl = undefined;
    try {
      const stop = startHeartbeat(clientThatIs(true), { url: undefined, fetchImpl, intervalMs: 1000 });
      vi.advanceTimersByTime(10_000);
      expect(calls).toEqual([]);
      stop();
    } finally {
      config.heartbeatUrl = saved;
    }
  });

  it('pings at once on start, then every interval, and stops when told', async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = recorder();
    const stop = startHeartbeat(clientThatIs(true), { url: 'https://hc-ping.com/abc', fetchImpl, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.length).toBe(4);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(4);
  });

  it('falls back to the configured URL and interval', async () => {
    vi.useFakeTimers();
    const { calls, fetchImpl } = recorder();
    const saved = { url: config.heartbeatUrl, mins: config.heartbeatIntervalMinutes };
    config.heartbeatUrl = 'https://hc-ping.com/from-env';
    config.heartbeatIntervalMinutes = 2;
    try {
      const stop = startHeartbeat(clientThatIs(true), { fetchImpl });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(calls).toEqual(['https://hc-ping.com/from-env', 'https://hc-ping.com/from-env']);
      stop();
    } finally {
      config.heartbeatUrl = saved.url;
      config.heartbeatIntervalMinutes = saved.mins;
    }
  });
});

describe('heartbeat config', () => {
  const good: AppConfig = {
    ...config,
    discordToken: 't',
    clientId: '1',
    heartbeatUrl: undefined,
    heartbeatIntervalMinutes: 5,
  };

  it('accepts no URL, and an https one', () => {
    expect(validateConfig(good)).toEqual([]);
    expect(validateConfig({ ...good, heartbeatUrl: 'https://hc-ping.com/abc' })).toEqual([]);
  });

  it('rejects a URL that is not http(s) -- it would fail silently on every tick', () => {
    const problems = validateConfig({ ...good, heartbeatUrl: 'hc-ping.com/abc' });
    expect(problems.some(p => p.includes('HEARTBEAT_URL'))).toBe(true);
  });

  it('rejects a non-numeric interval', () => {
    const problems = validateConfig({ ...good, heartbeatIntervalMinutes: NaN });
    expect(problems.some(p => p.includes('HEARTBEAT_INTERVAL_MINUTES'))).toBe(true);
  });
});
