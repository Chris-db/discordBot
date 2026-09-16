import { logger } from '../utils/logger';

/**
 * Logging in to Discord, with patience.
 *
 * On 2026-09-15 a deploy restarted the bot in the middle of a Discord outage. Login got a
 * 503, the process exited, systemd started it again, and that repeated 361 times in 14
 * minutes until Discord came back. Nothing was wrong on our side, and a process that had
 * simply waited would have reconnected at the same moment with none of the churn.
 *
 * So: a login that fails for a reason that can change (Discord down, network blip, rate
 * limit) is retried here with a growing delay, forever. A login that fails for a reason
 * that cannot change on its own -- a bad token, an intent the application is not allowed
 * -- is fatal, because retrying it would hide a config mistake behind an "online" service.
 *
 * The first failure is a warning; one is not news. After `escalateAfterMs` of continuous
 * failure a single error is logged so an issue exists for the outage.
 */

export interface LoginOptions {
  login: () => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  initialDelayMs?: number;
  maxDelayMs?: number;
  escalateAfterMs?: number;
  now?: () => number;
}

/** discord.js error codes for the reasons no amount of waiting will fix. */
const FATAL_CODES = new Set(['TokenInvalid', 'DisallowedIntents', 'InvalidIntents']);

export function isFatalLoginError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && FATAL_CODES.has(code)) return true;
  const status = (err as { status?: unknown })?.status;
  // 401/403 from the REST gateway lookup: the token is rejected, not the service.
  return status === 401 || status === 403;
}

export type LoginOutcome = 'ok' | 'fatal';

export async function loginWithRetry(opts: LoginOptions): Promise<LoginOutcome> {
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const initial = opts.initialDelayMs ?? 5_000;
  const max = opts.maxDelayMs ?? 60_000;
  const escalateAfter = opts.escalateAfterMs ?? 5 * 60_000;

  let delay = initial;
  let firstFailure: number | undefined;
  let escalated = false;

  for (;;) {
    try {
      await opts.login();
      if (firstFailure !== undefined) {
        logger.info(`Discord login succeeded after ${Math.round((now() - firstFailure) / 1000)}s of retrying.`);
      }
      return 'ok';
    } catch (err) {
      if (isFatalLoginError(err)) {
        logger.error('Failed to log in to Discord, and retrying cannot help (check DISCORD_TOKEN and the intents on the Discord developer portal):', err);
        return 'fatal';
      }
      firstFailure ??= now();
      const down = now() - firstFailure;
      if (!escalated && down >= escalateAfter) {
        escalated = true;
        logger.error(`Discord login has been failing for ${Math.round(down / 60_000)} min; still retrying every ${Math.round(delay / 1000)}s:`, err);
      } else {
        logger.warn(`Discord login failed (${describe(err)}); retrying in ${Math.round(delay / 1000)}s.`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, max);
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message.split('\n')[0];
  return String(err);
}
