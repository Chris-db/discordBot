import { describe, it, expect } from 'vitest';
import config, { validateConfig, AppConfig } from '../src/config';

const good: AppConfig = {
  ...config,
  discordToken: 'token',
  clientId: '123',
  defaultMmr: 1000,
  queueTimeoutMinutes: 30,
  matchTimeoutHours: 3,
  setupTimeoutMinutes: 15,
  draftPickTimeoutSeconds: 90,
  readyCheckTimeoutSeconds: 300,
  afkCooldownMinutes: 5,
  backupRetentionDays: 14,
  voteTimeoutSeconds: 60,
};

describe('validateConfig', () => {
  it('accepts a complete config', () => {
    expect(validateConfig(good)).toEqual([]);
  });

  it('names the missing secrets', () => {
    const problems = validateConfig({ ...good, discordToken: '', clientId: '' });
    expect(problems.some(p => p.includes('DISCORD_TOKEN'))).toBe(true);
    expect(problems.some(p => p.includes('CLIENT_ID'))).toBe(true);
  });

  it('rejects a NaN timeout, which parseInt produces from any typo', () => {
    const problems = validateConfig({ ...good, voteTimeoutSeconds: parseInt('sixty', 10) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('VOTE_TIMEOUT_SECONDS');
  });

  it('rejects zero and negative durations', () => {
    expect(validateConfig({ ...good, readyCheckTimeoutSeconds: 0 })).toHaveLength(1);
    expect(validateConfig({ ...good, matchTimeoutHours: -1 })).toHaveLength(1);
  });
});
