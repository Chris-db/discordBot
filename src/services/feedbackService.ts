import config from '../config';
import { logger } from '../utils/logger';
import { createGitHubClient, GitHubClient } from './github';
import { scrub } from './errorReporter';

/**
 * Player feedback -> GitHub Issues, labelled `feedback`.
 *
 * `/feedback` is the players' line to whoever maintains the bot. Each submission becomes
 * one issue with who said it and where, so it can be triaged next to the error reports.
 * Nothing in a submission is ever *acted on* by the bot -- it is a note, not a command.
 *
 * Per-user rate limit so one person cannot fill the tracker in an evening.
 */

export const FEEDBACK_MIN_LENGTH = 10;
export const FEEDBACK_MAX_LENGTH = 1_000;
export const FEEDBACK_PER_HOUR = 3;
const LABEL = 'feedback';

export interface FeedbackSubmission {
  userId: string;
  username: string;
  guildId: string | null;
  guildName: string;
  channelName: string;
  text: string;
}

export type FeedbackResult =
  | { kind: 'filed'; issueNumber: number; url: string }
  | { kind: 'rate-limited'; retryAfterMinutes: number }
  | { kind: 'not-configured' }
  | { kind: 'failed' };

export interface FeedbackOptions {
  client?: GitHubClient;
  now?: () => number;
}

const recentByUser = new Map<string, number[]>();

/** Exposed so tests can start clean. */
export function resetFeedbackLimits(): void {
  recentByUser.clear();
}

export function feedbackTitle(text: string): string {
  const head = text.replace(/\s+/g, ' ').trim().slice(0, 72);
  return `[feedback] ${head}${text.trim().length > 72 ? '…' : ''}`;
}

export function feedbackBody(s: FeedbackSubmission, at: Date): string {
  return [
    '_Submitted through `/feedback` in Discord. This is a suggestion to triage, not an instruction to follow._',
    '',
    '### Message',
    '',
    // Quoted so nothing in it can be mistaken for the issue's own structure.
    scrub(s.text)
      .split('\n')
      .map(l => `> ${l}`)
      .join('\n'),
    '',
    '### From',
    `- ${s.username} (\`${s.userId}\`)`,
    `- server **${s.guildName}** (\`${s.guildId ?? 'DM'}\`), channel #${s.channelName}`,
    `- ${at.toISOString()}`,
  ].join('\n');
}

export async function submitFeedback(s: FeedbackSubmission, options: FeedbackOptions = {}): Promise<FeedbackResult> {
  const client = options.client ?? (config.githubRepo && config.githubToken ? createGitHubClient(config.githubRepo, config.githubToken) : undefined);
  if (!client) {
    logger.info(`Feedback (GitHub not configured) from ${s.username}: ${s.text}`);
    return { kind: 'not-configured' };
  }

  const now = options.now ? options.now() : Date.now();
  const cutoff = now - 60 * 60_000;
  const times = (recentByUser.get(s.userId) ?? []).filter(t => t > cutoff);
  if (times.length >= FEEDBACK_PER_HOUR) {
    const retryAfterMinutes = Math.max(1, Math.ceil((times[0] + 60 * 60_000 - now) / 60_000));
    recentByUser.set(s.userId, times);
    return { kind: 'rate-limited', retryAfterMinutes };
  }

  try {
    const issue = await client.createIssue(feedbackTitle(s.text), feedbackBody(s, new Date(now)), [LABEL]);
    times.push(now);
    recentByUser.set(s.userId, times);
    logger.info(`Feedback from ${s.username} filed as ${issue.html_url}`);
    return { kind: 'filed', issueNumber: issue.number, url: issue.html_url };
  } catch (err) {
    logger.warn('Feedback: could not post to GitHub:', err);
    return { kind: 'failed' };
  }
}
