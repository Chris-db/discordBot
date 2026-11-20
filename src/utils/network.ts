import net from 'node:net';

/**
 * How long Node's happy-eyeballs gives each resolved address to connect before moving on
 * to the next one.
 *
 * Node's default is 250 ms, which is fine for nearby hosts but not for a home connection
 * in South Africa reaching a server in Europe: a TCP connect from the Pi to hc-ping.com
 * takes about 305 ms. hc-ping.com resolves to IPv6 and IPv4, the Pi has no working IPv6,
 * so the IPv6 attempt fails, the IPv4 attempt is cut off at 250 ms, and fetch throws
 * ETIMEDOUT after about a second -- every time. From 2026-11-20 every heartbeat failed
 * that way while the bot was connected to Discord, and Healthchecks reported it down.
 *
 * 2 s per attempt keeps the point of happy-eyeballs (a dead family is abandoned in a
 * bounded time) while leaving room for real round trips. Callers keep their own overall
 * timeouts; the heartbeat still gives up on a ping after 10 s.
 */
export const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

/**
 * Raises the per-address connect timeout for the whole process. Call it once at startup,
 * before anything opens a connection.
 *
 * Process-wide rather than scoped to the heartbeat's fetch, on purpose. Scoping it means
 * handing fetch an undici `Agent` with its own connect options, which needs undici as a
 * direct dependency; and the trap is not specific to the heartbeat -- Discord's REST and
 * gateway, the GitHub error reporter and any other outbound call from the Pi go through
 * the same `net.connect` default and would fail the same way against a far-away host.
 *
 * Never lowers a value that is already higher (for example one set with
 * `--network-family-autoselection-attempt-timeout`).
 */
export function relaxHappyEyeballs(): void {
  if (net.getDefaultAutoSelectFamilyAttemptTimeout() < AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS) {
    net.setDefaultAutoSelectFamilyAttemptTimeout(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS);
  }
}
