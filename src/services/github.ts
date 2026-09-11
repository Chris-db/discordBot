/**
 * The three GitHub REST calls the bot makes: open an issue, comment on one, read one.
 *
 * GitHub Issues is the bot's outbox. Errors and player feedback land there as issues so
 * that a person -- or an agent running against the repo -- can pick them up without
 * needing a way into the Pi. The token should be a fine-grained PAT scoped to this one
 * repository with Issues: read and write, and nothing else.
 */

export interface IssueRef {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
}

export interface GitHubClient {
  createIssue(title: string, body: string, labels: string[]): Promise<IssueRef>;
  commentIssue(issueNumber: number, body: string): Promise<void>;
  getIssue(issueNumber: number): Promise<IssueRef>;
}

/** The slice of fetch these calls need; a parameter so tests can hand in a recorder. */
export type GitHubFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export class GitHubError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

export function createGitHubClient(
  repo: string,
  token: string,
  fetchImpl: GitHubFetch = fetch as unknown as GitHubFetch,
  timeoutMs = 15_000
): GitHubClient {
  const base = `https://api.github.com/repos/${repo}`;

  async function call(method: string, path: string, payload?: unknown): Promise<any> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'rocket-league-6mans-bot',
        ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(res.status, `GitHub ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    async createIssue(title, body, labels) {
      const data = await call('POST', '/issues', { title, body, labels });
      return { number: data.number, html_url: data.html_url, state: data.state };
    },
    async commentIssue(issueNumber, body) {
      await call('POST', `/issues/${issueNumber}/comments`, { body });
    },
    async getIssue(issueNumber) {
      const data = await call('GET', `/issues/${issueNumber}`);
      return { number: data.number, html_url: data.html_url, state: data.state };
    },
  };
}
