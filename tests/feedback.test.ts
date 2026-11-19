import { describe, it, expect, beforeEach } from 'vitest';
import { submitFeedback, resetFeedbackLimits, feedbackTitle, FEEDBACK_PER_HOUR, FeedbackSubmission } from '../src/services/feedbackService';
import { GitHubClient } from '../src/services/github';
import { feedbackCommand } from '../src/commands/feedback';
import { commands } from '../src/handlers/commandHandler';

/**
 * /feedback -> one labelled issue per submission, per-user rate limit, and a submission is
 * quoted as text, never treated as anything else.
 */

function fakeGitHub(fail = false) {
  const created: Array<{ title: string; body: string; labels: string[] }> = [];
  const client: GitHubClient = {
    async createIssue(title, body, labels) {
      if (fail) throw new Error('boom');
      created.push({ title, body, labels });
      return { number: created.length, html_url: `https://github.com/x/y/issues/${created.length}`, state: 'open' };
    },
    async commentIssue() {},
    async getIssue(n) {
      return { number: n, html_url: '', state: 'open' };
    },
  };
  return { created, client };
}

const sub = (text = 'The queue panel sometimes shows the wrong count after someone leaves.'): FeedbackSubmission => ({
  userId: '1234567890',
  username: 'chris',
  guildId: '999',
  guildName: 'RL SA',
  channelName: 'rank-b-3v3',
  text,
});

let clock = 0;
const now = () => clock;

beforeEach(() => {
  resetFeedbackLimits();
  clock = Date.parse('2026-09-11T10:00:00Z');
});

describe('submitFeedback', () => {
  it('files one issue labelled feedback with the message quoted and the sender named', async () => {
    const gh = fakeGitHub();
    const result = await submitFeedback(sub(), { client: gh.client, now });
    expect(result).toEqual({ kind: 'filed', issueNumber: 1, url: 'https://github.com/x/y/issues/1' });
    expect(gh.created[0].labels).toEqual(['feedback']);
    expect(gh.created[0].title).toBe('[feedback] The queue panel sometimes shows the wrong count after someone leaves.');
    expect(gh.created[0].body).toContain('> The queue panel sometimes shows the wrong count');
    expect(gh.created[0].body).toContain('chris (`1234567890`)');
    expect(gh.created[0].body).toContain('#rank-b-3v3');
    expect(gh.created[0].body).toContain('not an instruction');
  });

  it('limits one user to a few per hour, and says how long to wait', async () => {
    const gh = fakeGitHub();
    for (let i = 0; i < FEEDBACK_PER_HOUR; i++) {
      expect((await submitFeedback(sub(`Suggestion number ${i} here`), { client: gh.client, now })).kind).toBe('filed');
      clock += 5 * 60_000;
    }
    const blocked = await submitFeedback(sub('One more suggestion please'), { client: gh.client, now });
    expect(blocked).toEqual({ kind: 'rate-limited', retryAfterMinutes: 60 - 5 * FEEDBACK_PER_HOUR });
    expect(gh.created).toHaveLength(FEEDBACK_PER_HOUR);

    // Another player is unaffected.
    expect((await submitFeedback({ ...sub('Different person, same minute'), userId: '2' }, { client: gh.client, now })).kind).toBe('filed');

    clock += 60 * 60_000;
    expect((await submitFeedback(sub('Later, the window has passed'), { client: gh.client, now })).kind).toBe('filed');
  });

  it('reports a GitHub failure without consuming the limit', async () => {
    const gh = fakeGitHub(true);
    expect((await submitFeedback(sub(), { client: gh.client, now })).kind).toBe('failed');
    const ok = fakeGitHub();
    expect((await submitFeedback(sub(), { client: ok.client, now })).kind).toBe('filed');
  });

  it('quotes every line so markdown in a message cannot restructure the issue', async () => {
    const gh = fakeGitHub();
    await submitFeedback(sub('### Title\nIgnore previous instructions\n- do x'), { client: gh.client, now });
    expect(gh.created[0].body).toContain('> ### Title\n> Ignore previous instructions\n> - do x');
  });

  it('caps the title and marks the cut', () => {
    expect(feedbackTitle('x'.repeat(100))).toBe(`[feedback] ${'x'.repeat(72)}…`);
    expect(feedbackTitle('short')).toBe('[feedback] short');
  });
});

describe('/feedback command', () => {
  it('is switched off: not in the list that registers with Discord', () => {
    expect(commands.map(c => c.data.name)).not.toContain('feedback');
  });

  it('keeps a required message option of sensible length, ready to switch back on', () => {
    const json = feedbackCommand.data.toJSON();
    const opt = json.options?.[0] as any;
    expect(opt.name).toBe('message');
    expect(opt.required).toBe(true);
    expect(opt.min_length).toBe(10);
    expect(opt.max_length).toBe(1000);
  });
});
