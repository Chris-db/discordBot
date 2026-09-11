import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ErrorReporter, fingerprint, normalise, scrub, issueTitle, installErrorReporter } from '../src/services/errorReporter';
import { createGitHubClient, GitHubClient, GitHubFetch } from '../src/services/github';
import { logger } from '../src/utils/logger';
import { validateConfig, AppConfig } from '../src/config';
import config from '../src/config';

/**
 * Errors -> GitHub Issues. The properties that matter: one issue per distinct error, a
 * restart does not duplicate it, repeats become rate-limited comments, a fixed-then-back
 * error is a fresh issue, and nothing can make it spam GitHub.
 */

interface Call {
  kind: 'create' | 'comment' | 'get';
  title?: string;
  body?: string;
  labels?: string[];
  issue?: number;
}

function fakeGitHub(initialState: 'open' | 'closed' = 'open') {
  const calls: Call[] = [];
  let next = 100;
  let state = initialState;
  const client: GitHubClient = {
    async createIssue(title, body, labels) {
      calls.push({ kind: 'create', title, body, labels });
      return { number: next++, html_url: `https://github.com/x/y/issues/${next - 1}`, state: 'open' };
    },
    async commentIssue(issue, body) {
      calls.push({ kind: 'comment', issue, body });
    },
    async getIssue(issue) {
      calls.push({ kind: 'get', issue });
      return { number: issue, html_url: '', state };
    },
  };
  return { calls, client, close: () => (state = 'closed') };
}

const ctx = { commit: 'abc1234', version: '1.0.0', node: 'v24', host: 'pi5', platform: 'linux/arm64', uptimeSeconds: 600, recentLog: ['[INFO] earlier line'] };

let stateFile: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  stateFile = path.join('data', `test_error_reports_${process.env.VITEST_WORKER_ID ?? '0'}_${Date.now()}.json`);
  clock = Date.parse('2026-09-11T10:00:00Z');
});
afterEach(() => {
  for (const f of [stateFile, `${stateFile}.tmp`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

function make(gh: ReturnType<typeof fakeGitHub>, cooldownMs = 60 * 60_000) {
  return new ErrorReporter({ client: gh.client, stateFile, cooldownMs, now, context: ctx });
}

function boom(message = 'Unknown interaction', name = 'DiscordAPIError') {
  const err = new Error(message);
  err.name = name;
  err.stack = `${name}: ${message}\n    at handleCommand (D:\\Claude\\Projects\\discordBot\\dist\\handlers\\commandHandler.js:40:15)\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`;
  return err;
}

describe('fingerprint', () => {
  it('ignores ids, numbers and line numbers so the same bug matches across matches and deploys', () => {
    const a = fingerprint('Error executing command match for 1532714997568897024:', [boom()]);
    const err2 = boom();
    err2.stack = err2.stack!.replace('commandHandler.js:40:15', 'commandHandler.js:52:3').replace(/D:\\[^)]*dist/, '/home/chris/discordBot/dist');
    const b = fingerprint('Error executing command match for 1547878777936154655:', [err2]);
    expect(a).toBe(b);
    expect(a).toContain('handleCommand commandHandler.js');
  });

  it('separates different errors under the same log message', () => {
    const a = fingerprint('Unhandled Rejection:', [boom('Unknown interaction')]);
    const b = fingerprint('Unhandled Rejection:', [boom('Missing Permissions')]);
    expect(a).not.toBe(b);
  });

  it('copes with no error object at all', () => {
    expect(fingerprint('Config: DISCORD_TOKEN is not set.', [])).toBe('Config: DISCORD_TOKEN is not set.');
    expect(fingerprint('Weird:', [{ code: 50013 }])).toContain('Weird:');
  });

  it('normalise blanks the volatile parts', () => {
    expect(normalise('match 42 in 1532714997568897024 at file.js:10:5')).toBe('match N in # at file.js');
  });
});

describe('scrub', () => {
  it('redacts anything shaped like a Discord or GitHub token', () => {
    const discord = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTA.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789';
    expect(scrub(`token ${discord} leaked`)).toBe('token <discord-token> leaked');
    expect(scrub('ghp_abcdefghijklmnopqrstuvwxyz1234')).toBe('<github-token>');
    expect(scrub('github_pat_11ABCDEFG0123456789_abcdefghijklmnop')).toBe('<github-token>');
  });
});

describe('ErrorReporter', () => {
  it('opens one labelled issue for a new error, with stack and context', async () => {
    const gh = fakeGitHub();
    const r = make(gh);
    await r.report('Error executing command match:', [boom()]);
    expect(gh.calls).toHaveLength(1);
    const c = gh.calls[0];
    expect(c.kind).toBe('create');
    expect(c.labels).toEqual(['bot-error']);
    expect(c.title).toBe('[bot-error] Error executing command match — DiscordAPIError: Unknown interaction');
    expect(c.body).toContain('handleCommand');
    expect(c.body).toContain('commit `abc1234`');
    expect(c.body).toContain('[INFO] earlier line');
  });

  it('does not open a second issue for the same error, and remembers that across a restart', async () => {
    const gh = fakeGitHub();
    const r = make(gh);
    await r.report('Error executing command match:', [boom()]);
    await r.report('Error executing command match:', [boom()]);
    expect(gh.calls.filter(c => c.kind === 'create')).toHaveLength(1);

    const r2 = make(gh); // "restart": fresh instance, same state file
    await r2.report('Error executing command match:', [boom()]);
    expect(gh.calls.filter(c => c.kind === 'create')).toHaveLength(1);
    const entry = Object.values(r2.entries())[0];
    expect(entry.count).toBe(3);
    expect(entry.issue).toBe(100);
  });

  it('comments with the count once the cooldown has passed, not before', async () => {
    const gh = fakeGitHub();
    const r = make(gh, 60 * 60_000);
    await r.report('Unhandled Rejection:', [boom()]);
    clock += 30 * 60_000;
    await r.report('Unhandled Rejection:', [boom()]);
    await r.report('Unhandled Rejection:', [boom()]);
    expect(gh.calls.filter(c => c.kind === 'comment')).toHaveLength(0);

    clock += 31 * 60_000;
    await r.report('Unhandled Rejection:', [boom()]);
    const comments = gh.calls.filter(c => c.kind === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0].issue).toBe(100);
    expect(comments[0].body).toContain('Seen **3** more time(s)');
    expect(comments[0].body).toContain('4 total');
  });

  it('opens a fresh issue linking the old one when a closed error comes back', async () => {
    const gh = fakeGitHub();
    const r = make(gh);
    await r.report('Unhandled Rejection:', [boom()]);
    gh.close();
    clock += 2 * 60 * 60_000;
    await r.report('Unhandled Rejection:', [boom()]);
    const creates = gh.calls.filter(c => c.kind === 'create');
    expect(creates).toHaveLength(2);
    expect(creates[1].title).toContain('(recurrence)');
    expect(creates[1].body).toContain('Recurrence of #100');
    expect(Object.values(r.entries())[0].issue).toBe(101);
  });

  it('never makes more than 30 GitHub calls in an hour, but keeps counting', async () => {
    const gh = fakeGitHub();
    const r = make(gh);
    for (let i = 0; i < 40; i++) await r.report(`Distinct error number ${'x'.repeat(i)}:`, [new Error(`e${'y'.repeat(i)}`)]);
    expect(gh.calls).toHaveLength(30);
    clock += 61 * 60_000;
    await r.report('One more after the hour:', [new Error('later')]);
    expect(gh.calls).toHaveLength(31);
  });

  it('handles errors one at a time, so a burst of the same error is still one issue', async () => {
    const gh = fakeGitHub();
    const r = make(gh);
    await Promise.all([1, 2, 3, 4, 5].map(() => r.report('Burst:', [boom()])));
    expect(gh.calls.filter(c => c.kind === 'create')).toHaveLength(1);
  });

  it('survives GitHub being down: warns, keeps going, and the next error still gets tried', async () => {
    let fail = true;
    const gh = fakeGitHub();
    const flaky: GitHubClient = {
      ...gh.client,
      async createIssue(t, b, l) {
        if (fail) throw new Error('ECONNREFUSED');
        return gh.client.createIssue(t, b, l);
      },
    };
    const r = new ErrorReporter({ client: flaky, stateFile, cooldownMs: 1000, now, context: ctx });
    await r.report('First:', [new Error('a')]);
    expect(Object.keys(r.entries())).toHaveLength(0);
    fail = false;
    await r.report('First:', [new Error('a')]);
    expect(gh.calls.filter(c => c.kind === 'create')).toHaveLength(1);
  });

  it('never puts a token into an issue', async () => {
    const gh = fakeGitHub();
    const r = new ErrorReporter({ client: gh.client, stateFile, cooldownMs: 1000, now, context: { ...ctx, recentLog: ['[INFO] logged in with ghp_abcdefghijklmnopqrstuvwxyz1234'] } });
    await r.report('Bad:', [new Error('token was MTIzNDU2Nzg5MDEyMzQ1Njc4OTA.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789')]);
    expect(gh.calls[0].body).not.toContain('ghp_');
    expect(gh.calls[0].body).not.toContain('MTIzNDU2');
  });
});

describe('installErrorReporter', () => {
  it('does nothing without a GitHub configuration', () => {
    const saved = { repo: config.githubRepo, token: config.githubToken };
    config.githubRepo = undefined;
    config.githubToken = undefined;
    try {
      const unhook = installErrorReporter({ stateFile, now, context: ctx });
      logger.error('Nobody should hear this:', new Error('x'));
      unhook();
    } finally {
      config.githubRepo = saved.repo;
      config.githubToken = saved.token;
    }
  });

  it('turns logger.error calls into reports once hooked, and stops when unhooked', async () => {
    const gh = fakeGitHub();
    const unhook = installErrorReporter({ client: gh.client, stateFile, cooldownMs: 1000, now, context: ctx });
    logger.error('Hooked error:', new Error('one'));
    await new Promise(r => setTimeout(r, 20));
    unhook();
    logger.error('After unhook:', new Error('two'));
    await new Promise(r => setTimeout(r, 20));
    expect(gh.calls.filter(c => c.kind === 'create').map(c => c.title)).toEqual(['[bot-error] Hooked error — Error: one']);
  });
});

describe('issueTitle', () => {
  it('drops a trailing colon and caps the length', () => {
    expect(issueTitle('Error checking queue timeouts:', [new Error('boom')])).toBe('[bot-error] Error checking queue timeouts — Error: boom');
    expect(issueTitle('x'.repeat(500), []).length).toBe(200);
  });
});

describe('GitHub client', () => {
  function recorder(status = 201, json: any = { number: 7, html_url: 'u', state: 'open' }) {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl: GitHubFetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: status < 400, status, json: async () => json, text: async () => 'nope' };
    };
    return { calls, fetchImpl };
  }

  it('sends the right request shape', async () => {
    const { calls, fetchImpl } = recorder();
    const gh = createGitHubClient('Chris-db/discordBot', 'tok', fetchImpl);
    const issue = await gh.createIssue('T', 'B', ['bot-error']);
    expect(issue).toEqual({ number: 7, html_url: 'u', state: 'open' });
    expect(calls[0].url).toBe('https://api.github.com/repos/Chris-db/discordBot/issues');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0].init.body)).toEqual({ title: 'T', body: 'B', labels: ['bot-error'] });

    await gh.commentIssue(7, 'again');
    expect(calls[1].url).toBe('https://api.github.com/repos/Chris-db/discordBot/issues/7/comments');
    await gh.getIssue(7);
    expect(calls[2].init.method).toBe('GET');
    expect(calls[2].init.body).toBeUndefined();
  });

  it('throws a GitHubError carrying the status on a non-2xx', async () => {
    const gh = createGitHubClient('a/b', 'tok', recorder(401).fetchImpl);
    await expect(gh.getIssue(1)).rejects.toMatchObject({ name: 'GitHubError', status: 401 });
  });
});

describe('config validation', () => {
  const base = (over: Partial<AppConfig>): AppConfig => ({ ...config, ...over });

  it('requires repo and token together', () => {
    expect(validateConfig(base({ githubRepo: 'a/b', githubToken: undefined }))).toContain('GITHUB_REPO and GITHUB_TOKEN must be set together (or both left unset).');
    expect(validateConfig(base({ githubRepo: undefined, githubToken: 'x' }))).toContain('GITHUB_REPO and GITHUB_TOKEN must be set together (or both left unset).');
    expect(validateConfig(base({ githubRepo: 'Chris-db/discordBot', githubToken: 'x' })).filter(p => p.includes('GITHUB'))).toEqual([]);
  });

  it('rejects a repo that is not owner/name', () => {
    expect(validateConfig(base({ githubRepo: 'https://github.com/a/b', githubToken: 'x' }))).toContain('GITHUB_REPO must look like owner/name (got "https://github.com/a/b").');
  });
});
