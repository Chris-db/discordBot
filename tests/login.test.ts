import { describe, it, expect } from 'vitest';
import { loginWithRetry, isFatalLoginError } from '../src/services/login';
import { ErrorReporter, installErrorReporter, flushErrorReports } from '../src/services/errorReporter';
import { GitHubClient } from '../src/services/github';
import { logger } from '../src/utils/logger';
import fs from 'fs';
import path from 'path';

/**
 * The Discord outage of 2026-09-15: login got 503s, the process exited, systemd restarted
 * it 361 times. Two properties: a login that fails for a passing reason is retried with
 * backoff and never exits; and an error that does end the process reaches GitHub first.
 */

function outage(failures: number, err: () => unknown) {
  let attempts = 0;
  const login = async () => {
    attempts += 1;
    if (attempts <= failures) throw err();
  };
  return { login, attempts: () => attempts };
}

const http503 = () => Object.assign(new Error('Unexpected server response: 503'), { name: 'Error' });
const noSleep = { sleep: async () => {} };

describe('loginWithRetry', () => {
  it('keeps trying through a Discord outage and comes back when Discord does', async () => {
    const o = outage(361, http503);
    const delays: number[] = [];
    const result = await loginWithRetry({ login: o.login, sleep: async ms => void delays.push(ms), initialDelayMs: 5_000, maxDelayMs: 60_000 });
    expect(result).toBe('ok');
    expect(o.attempts()).toBe(362);
    // Backoff: 5s, 10s, 20s, 40s, then capped at 60s.
    expect(delays.slice(0, 5)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
    expect(Math.max(...delays)).toBe(60_000);
  });

  it('gives up at once on a rejected token or intents, which waiting cannot fix', async () => {
    for (const err of [
      Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' }),
      Object.assign(new Error('Used disallowed intents'), { code: 'DisallowedIntents' }),
      Object.assign(new Error('401: Unauthorized'), { status: 401 }),
    ]) {
      const o = outage(99, () => err);
      expect(await loginWithRetry({ login: o.login, ...noSleep })).toBe('fatal');
      expect(o.attempts()).toBe(1);
      expect(isFatalLoginError(err)).toBe(true);
    }
    expect(isFatalLoginError(http503())).toBe(false);
    expect(isFatalLoginError(Object.assign(new Error('Internal Server Error'), { status: 500 }))).toBe(false);
  });

  it('warns on each failure but logs one error once the outage has lasted a while', async () => {
    const seen: string[] = [];
    const unhook = logger.onError(msg => void seen.push(msg));
    let clock = 0;
    const o = outage(10, http503);
    await loginWithRetry({
      login: o.login,
      sleep: async ms => void (clock += ms),
      now: () => clock,
      initialDelayMs: 60_000,
      maxDelayMs: 60_000,
      escalateAfterMs: 5 * 60_000,
    });
    unhook();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('has been failing for 5 min');
  });
});

describe('flushErrorReports', () => {
  const stateFile = path.join('data', `test_flush_${process.env.VITEST_WORKER_ID ?? '0'}.json`);

  it('waits for a queued report to reach GitHub before the process may exit', async () => {
    let resolveCreate: (() => void) | undefined;
    const created: string[] = [];
    const client: GitHubClient = {
      createIssue: (title) =>
        new Promise(resolve => {
          resolveCreate = () => {
            created.push(title);
            resolve({ number: 1, html_url: 'u', state: 'open' });
          };
        }),
      commentIssue: async () => {},
      getIssue: async n => ({ number: n, html_url: '', state: 'open' }),
    };
    const unhook = installErrorReporter({ client, stateFile, cooldownMs: 1000, context: { commit: 'x', version: '1', node: 'v', host: 'h', platform: 'p', uptimeSeconds: 1, recentLog: [] } });
    try {
      logger.error('Fatal thing:', new Error('boom'));
      let flushed = false;
      const flush = flushErrorReports(10_000).then(() => void (flushed = true));
      await new Promise(r => setTimeout(r, 20));
      expect(flushed).toBe(false); // still waiting on GitHub
      resolveCreate!();
      await flush;
      expect(created).toEqual(['[bot-error] Fatal thing — Error: boom']);
    } finally {
      unhook();
      for (const f of [stateFile, `${stateFile}.tmp`]) if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('does not hang forever if GitHub never answers', async () => {
    const client: GitHubClient = {
      createIssue: () => new Promise(() => {}),
      commentIssue: async () => {},
      getIssue: async n => ({ number: n, html_url: '', state: 'open' }),
    };
    const unhook = installErrorReporter({ client, stateFile, cooldownMs: 1000, context: { commit: 'x', version: '1', node: 'v', host: 'h', platform: 'p', uptimeSeconds: 1, recentLog: [] } });
    try {
      logger.error('Hangs:', new Error('never'));
      const started = Date.now();
      await flushErrorReports(50);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      unhook();
      for (const f of [stateFile, `${stateFile}.tmp`]) if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('is a no-op when no reporter is installed', async () => {
    await flushErrorReports(10);
    expect(new ErrorReporter({ client: {} as any, stateFile }).idle()).resolves.toBeUndefined();
  });
});
