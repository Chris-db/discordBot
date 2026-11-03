import { Status } from 'discord.js';
import config from '../config';
import { logger } from '../utils/logger';

/**
 * Uptime heartbeat.
 *
 * The bot has no HTTP surface and the Pi sits behind home internet with nothing inbound,
 * so a monitor cannot poll it. Instead the bot pings a URL on a schedule and the monitor
 * (Healthchecks.io, UptimeRobot heartbeat, Better Stack -- anything that alerts when the
 * pings *stop*) raises the alarm when one is late.
 *
 * A ping is only sent while the Discord gateway is actually connected, so a dead Pi, a
 * hung process, a crash loop and a dropped gateway all look the same to the monitor: the
 * heartbeat stops. A ping that the bot sent but the monitor never received is treated the
 * same way -- there is nothing to do about it here except say so once in the log.
 *
 * Nothing runs unless HEARTBEAT_URL is set.
 */

/** The fetch shape the heartbeat needs; a parameter so tests can hand in a recorder. */
export type FetchLike = (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface HeartbeatOptions {
  url?: string;
  intervalMs?: number;
  fetchImpl?: FetchLike;
  /** How long one ping may take before it counts as failed. */
  timeoutMs?: number;
}

export type BeatResult = 'sent' | 'skipped' | 'failed';

/** The slice of the client the heartbeat reads: just the gateway shards and their status. */
export type GatewayClient = { ws: { shards: { values(): Iterable<{ status: Status }>; size: number } } };

/**
 * Whether every gateway shard is connected right now.
 *
 * Deliberately NOT `client.isReady()`. A failed `client.login()` makes discord.js call
 * `client.destroy()`, which sets `client.ws.destroyed = true` -- and nothing ever sets it
 * back. `loginWithRetry` then logs in again on the same client, the bot works normally,
 * but `isReady()` is false for the life of the process. The Pi boots before its WiFi is
 * up, so the first login fails on almost every boot: from 2026-09-18 every heartbeat was
 * silently skipped and Healthchecks saw the bot "down" for six weeks while it was online.
 *
 * Shard status has no such latch: it goes to Connecting when the socket closes and back
 * to Ready on resume or re-identify, so it tracks the connection as it is now.
 */
export function gatewayConnected(client: GatewayClient): boolean {
  const shards = client.ws.shards;
  if (shards.size === 0) return false;
  for (const shard of shards.values()) {
    if (shard.status !== Status.Ready) return false;
  }
  return true;
}

/**
 * One ping. Skipped when the gateway is not connected -- that is the whole point: the
 * monitor must not hear from a bot that cannot hear from Discord.
 */
export async function beat(
  client: GatewayClient,
  url: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 10_000
): Promise<BeatResult> {
  if (!gatewayConnected(client)) return 'skipped';
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Starts the schedule. The first ping goes out at once, so a restart reaches the monitor
 * within seconds rather than a full interval later. Returns a function that stops it.
 *
 * Failures are logged on the change of state, not on every tick: a monitor that is down
 * for an hour is one warning and one "back" line, not twelve warnings. Skips are logged
 * the same way -- a heartbeat that holds its pings without saying so is how the
 * `isReady()` latch above went unnoticed for six weeks.
 */
export function startHeartbeat(client: GatewayClient, options: HeartbeatOptions = {}): () => void {
  const url = options.url ?? config.heartbeatUrl;
  if (!url) return () => {};

  const intervalMs = options.intervalMs ?? config.heartbeatIntervalMinutes * 60_000;
  const fetchImpl = options.fetchImpl;
  const timeoutMs = options.timeoutMs;

  let lastFailed = false;
  let lastSkipped = false;
  const tick = async () => {
    const result = await beat(client, url, fetchImpl, timeoutMs);
    if (result === 'skipped' && !lastSkipped) {
      logger.warn('Heartbeat paused: the Discord gateway is not connected, so the uptime monitor will think the bot is down until it reconnects.');
    } else if (result !== 'skipped' && lastSkipped) {
      logger.info('Heartbeat resumed: the Discord gateway is connected again.');
    }
    lastSkipped = result === 'skipped';
    if (result === 'failed' && !lastFailed) {
      logger.warn(`Heartbeat ping to ${describe(url)} failed. The uptime monitor will think the bot is down until this recovers.`);
    } else if (result === 'sent' && lastFailed) {
      logger.info(`Heartbeat ping to ${describe(url)} is working again.`);
    }
    if (result !== 'skipped') lastFailed = result === 'failed';
  };

  logger.info(`Heartbeat: pinging ${describe(url)} every ${Math.round(intervalMs / 60_000)} min while connected.`);
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  // Never the reason the process stays alive.
  timer.unref?.();
  return () => clearInterval(timer);
}

/** The host only: a heartbeat URL is a secret (anyone who has it can fake the bot being up). */
function describe(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the heartbeat URL';
  }
}
