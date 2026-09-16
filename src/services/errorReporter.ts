import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import config from '../config';
import { logger } from '../utils/logger';
import { createGitHubClient, GitHubClient } from './github';

/**
 * Runtime errors -> GitHub Issues.
 *
 * Every failure in the bot passes through `logger.error`. This module listens there and
 * turns each *distinct* error into one issue labelled `bot-error`, with the stack, the
 * lines logged just before it, and enough about the process (commit, node, host, uptime)
 * to reproduce it. A repeat of the same error adds a comment to its issue, at most once per
 * cooldown, with the count -- so a bug that fires 400 times overnight is one issue with one
 * "seen 400 more times" note, not 400 issues. An error that comes back after its issue was
 * closed opens a fresh issue that links the old one.
 *
 * "Same error" is decided by a fingerprint: the message and the top stack frame with the
 * volatile parts (Discord ids, numbers, line numbers) blanked out, so the fingerprint
 * survives a redeploy and a different match number.
 *
 * What it will never do: report its own failures through `logger.error` (that would loop),
 * or make more than `MAX_CALLS_PER_HOUR` GitHub calls in an hour. Past that budget errors
 * are still counted locally and still in the journal; they just are not posted.
 *
 * State (fingerprint -> issue number, counts, timestamps) lives in
 * `data/error-reports.json` so a restart does not open duplicate issues.
 */

const MAX_CALLS_PER_HOUR = 30;
const STACK_LIMIT = 4_000;
const LABEL = 'bot-error';

interface ReportEntry {
  issue: number;
  url: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** When we last created or commented; the cooldown counts from here. */
  lastPosted: string;
  /** Occurrences since `lastPosted`, reported in the next comment. */
  sinceLastPost: number;
}

type ReportState = Record<string, ReportEntry>;

export interface ErrorReporterOptions {
  client?: GitHubClient;
  stateFile?: string;
  cooldownMs?: number;
  now?: () => number;
  /** Process facts for the issue body; the defaults read them from the real process. */
  context?: Partial<ProcessContext>;
}

export interface ProcessContext {
  commit: string;
  version: string;
  node: string;
  host: string;
  platform: string;
  uptimeSeconds: number;
  recentLog: string[];
}

/**
 * Blanks the parts of a string that change between two occurrences of the same bug:
 * Discord snowflakes and any other long number, hex ids, quoted paths, and `:line:col`
 * suffixes on stack frames.
 */
export function normalise(text: string): string {
  return text
    .replace(/\b\d{5,}\b/g, '#')
    .replace(/\b[0-9a-f]{12,}\b/gi, '#')
    .replace(/:\d+:\d+\)?/g, '')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first "at ..." frame of a stack that points into our own code, or the first frame at all. */
function topFrame(stack: string | undefined): string {
  if (!stack) return '';
  const frames = stack.split('\n').map(l => l.trim()).filter(l => l.startsWith('at '));
  const ours = frames.find(f => !f.includes('node_modules') && !f.includes('node:internal'));
  const frame = ours ?? frames[0] ?? '';
  // Keep the function and the file name; drop the directory so Windows and the Pi agree.
  const m = frame.match(/^at\s+(?:(\S.*?)\s+\()?(.*?)\)?$/);
  if (!m) return frame;
  const fn = m[1] ?? '';
  const file = m[2].split(/[\\/]/).pop() ?? '';
  return `${fn} ${file}`.trim();
}

export function fingerprint(msg: string, args: unknown[]): string {
  const err = args.find((a): a is Error => a instanceof Error);
  const parts = [normalise(msg.split('\n')[0])];
  if (err) {
    parts.push(`${err.name}: ${normalise(err.message.split('\n')[0])}`);
    parts.push(normalise(topFrame(err.stack)));
  } else if (args.length) {
    parts.push(normalise(String(args[0]).split('\n')[0]).slice(0, 120));
  }
  return parts.filter(Boolean).join(' | ');
}

/** Tokens must never reach an issue, even if something logged one by mistake. */
export function scrub(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g, '<discord-token>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<github-token>')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<github-token>');
}

function readGitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function readVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function describeError(args: unknown[]): string {
  const err = args.find((a): a is Error => a instanceof Error);
  if (err) return err.stack ?? `${err.name}: ${err.message}`;
  if (!args.length) return '(no error object)';
  return args
    .map(a => {
      try {
        return typeof a === 'string' ? a : JSON.stringify(a, null, 2);
      } catch {
        return String(a);
      }
    })
    .join('\n');
}

export function issueTitle(msg: string, args: unknown[]): string {
  const err = args.find((a): a is Error => a instanceof Error);
  const head = msg.split('\n')[0].replace(/:\s*$/, '');
  const detail = err ? `${err.name}: ${err.message.split('\n')[0]}` : '';
  const title = detail ? `${head} — ${detail}` : head;
  return `[bot-error] ${title}`.slice(0, 200);
}

export function issueBody(msg: string, args: unknown[], ctx: ProcessContext, fp: string): string {
  const stack = scrub(describeError(args)).slice(0, STACK_LIMIT);
  const recent = scrub(ctx.recentLog.join('\n')).slice(-6_000);
  return [
    '_Opened automatically by the bot. One issue per distinct error; repeats are added as comments._',
    '',
    `**Message:** ${scrub(msg)}`,
    '',
    '### Error',
    '```',
    stack,
    '```',
    '',
    '### Process',
    `- commit \`${ctx.commit}\` · version ${ctx.version} · node ${ctx.node} · ${ctx.platform} on \`${ctx.host}\``,
    `- uptime ${Math.round(ctx.uptimeSeconds / 60)} min at the time of the error`,
    `- fingerprint \`${scrub(fp)}\``,
    '',
    '### Log leading up to it',
    '```',
    recent || '(nothing logged before this)',
    '```',
  ].join('\n');
}

export class ErrorReporter {
  private readonly client: GitHubClient;
  private readonly stateFile: string;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly ctx: Partial<ProcessContext>;
  private readonly state: ReportState;
  /** Timestamps of GitHub calls in the last hour, for the budget. */
  private calls: number[] = [];
  /** Reports are processed one at a time so two of the same error cannot both open an issue. */
  private chain: Promise<void> = Promise.resolve();
  private budgetWarned = false;

  constructor(options: ErrorReporterOptions) {
    if (!options.client) throw new Error('ErrorReporter needs a GitHub client');
    this.client = options.client;
    this.stateFile = options.stateFile ?? path.join(process.cwd(), 'data', 'error-reports.json');
    this.cooldownMs = options.cooldownMs ?? config.errorReportCooldownMinutes * 60_000;
    this.now = options.now ?? Date.now;
    this.ctx = options.context ?? {};
    this.state = this.loadState();
  }

  /** Queue one error. Returns when it has been handled (tests await this; the bot does not). */
  report(msg: string, args: unknown[]): Promise<void> {
    this.chain = this.chain
      .then(() => this.handle(msg, args))
      .catch(err => logger.warn('Error reporter: could not post to GitHub:', err));
    return this.chain;
  }

  /** Resolves once every report queued so far has been handled (or failed). */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Read-only view for tests and diagnostics. */
  entries(): ReportState {
    return JSON.parse(JSON.stringify(this.state));
  }

  private async handle(msg: string, args: unknown[]): Promise<void> {
    const fp = fingerprint(msg, args);
    const nowIso = new Date(this.now()).toISOString();
    const entry = this.state[fp];

    if (!entry) {
      if (!this.spend()) return;
      const issue = await this.client.createIssue(issueTitle(msg, args), issueBody(msg, args, this.context(), fp), [LABEL]);
      this.state[fp] = { issue: issue.number, url: issue.html_url, count: 1, firstSeen: nowIso, lastSeen: nowIso, lastPosted: nowIso, sinceLastPost: 0 };
      this.saveState();
      logger.warn(`Reported new error as ${issue.html_url}`);
      return;
    }

    entry.count += 1;
    entry.sinceLastPost += 1;
    entry.lastSeen = nowIso;
    const due = this.now() - Date.parse(entry.lastPosted) >= this.cooldownMs;
    if (!due) {
      this.saveState();
      return;
    }

    if (!this.spend()) {
      this.saveState();
      return;
    }
    const existing = await this.client.getIssue(entry.issue);
    if (existing.state === 'open') {
      if (!this.spend()) {
        this.saveState();
        return;
      }
      await this.client.commentIssue(
        entry.issue,
        `Seen **${entry.sinceLastPost}** more time(s) since the last note (${entry.count} total since ${entry.firstSeen}). Latest at ${nowIso} on commit \`${this.context().commit}\`.\n\n` +
          '```\n' +
          scrub(describeError(args)).slice(0, STACK_LIMIT) +
          '\n```'
      );
      entry.lastPosted = nowIso;
      entry.sinceLastPost = 0;
      this.saveState();
      return;
    }

    // Closed, presumably as fixed -- and it is back. That deserves a fresh issue.
    if (!this.spend()) {
      this.saveState();
      return;
    }
    const body = `**Recurrence of #${entry.issue}**, which was closed. Seen ${entry.sinceLastPost} time(s) since then.\n\n` + issueBody(msg, args, this.context(), fp);
    const issue = await this.client.createIssue(issueTitle(msg, args) + ' (recurrence)', body, [LABEL]);
    this.state[fp] = { issue: issue.number, url: issue.html_url, count: entry.count, firstSeen: entry.firstSeen, lastSeen: nowIso, lastPosted: nowIso, sinceLastPost: 0 };
    this.saveState();
    logger.warn(`Error from closed issue #${entry.issue} is back; reported as ${issue.html_url}`);
  }

  /** Takes one call from the hourly budget; false (and a single warning) when it is spent. */
  private spend(): boolean {
    const cutoff = this.now() - 60 * 60_000;
    this.calls = this.calls.filter(t => t > cutoff);
    if (this.calls.length >= MAX_CALLS_PER_HOUR) {
      if (!this.budgetWarned) {
        logger.warn(`Error reporter: ${MAX_CALLS_PER_HOUR} GitHub calls in an hour; holding further reports until it clears.`);
        this.budgetWarned = true;
      }
      return false;
    }
    this.budgetWarned = false;
    this.calls.push(this.now());
    return true;
  }

  private context(): ProcessContext {
    return {
      commit: this.ctx.commit ?? readGitCommit(),
      version: this.ctx.version ?? readVersion(),
      node: this.ctx.node ?? process.version,
      host: this.ctx.host ?? os.hostname(),
      platform: this.ctx.platform ?? `${process.platform}/${process.arch}`,
      uptimeSeconds: this.ctx.uptimeSeconds ?? process.uptime(),
      recentLog: this.ctx.recentLog ?? logger.recent(),
    };
  }

  private loadState(): ReportState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.stateFile);
    } catch (err) {
      logger.warn('Error reporter: could not save state file:', err);
    }
  }
}

/**
 * Wires the reporter to the logger. Does nothing without GITHUB_REPO + GITHUB_TOKEN.
 * Returns a function that unhooks it.
 */
let active: ErrorReporter | undefined;

export function installErrorReporter(options: ErrorReporterOptions = {}): () => void {
  const client = options.client ?? (config.githubRepo && config.githubToken ? createGitHubClient(config.githubRepo, config.githubToken) : undefined);
  if (!client) return () => {};

  const reporter = new ErrorReporter({ ...options, client });
  active = reporter;
  // The reporter's own failures go through logger.warn, never logger.error, so this cannot
  // feed back into itself.
  const unhook = logger.onError((msg, args) => void reporter.report(msg, args));
  logger.info(`Error reporter: distinct errors will be opened as issues on ${config.githubRepo ?? 'GitHub'}.`);
  return () => {
    unhook();
    if (active === reporter) active = undefined;
  };
}

/**
 * Waits for queued reports to reach GitHub, up to `timeoutMs`. Call before `process.exit`:
 * the errors that end the process are exactly the ones worth an issue, and the Discord
 * outage of 2026-09-15 went unreported because the exit came first.
 */
export function flushErrorReports(timeoutMs = 5_000): Promise<void> {
  if (!active) return Promise.resolve();
  return Promise.race([
    active.idle(),
    new Promise<void>(resolve => {
      const t = setTimeout(resolve, timeoutMs);
      t.unref?.();
    }),
  ]);
}
