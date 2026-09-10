import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import db from '../src/database/db';
import {
  createMatch,
  updateMatch,
  getRecentlyFinishedMatchesWithChannels,
} from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import { sweepOrphanedMatchChannels } from '../src/services/queueTimeout';
import {
  scheduleMatchChannelDeletion,
  cancelMatchChannelDeletion,
} from '../src/services/channelService';

const G = 'guild_orphan_test';
const BLUE = ['b1', 'b2', 'b3'];
const ORANGE = ['o1', 'o2', 'o3'];

const HOUR = 60 * 60 * 1000;

/** A finished match, finished `agoMs` ago, that still carries channel ids. */
function finishedMatch(agoMs: number, overrides: Record<string, unknown> = {}) {
  const match = createMatch({
    guild_id: G,
    channel_id: 'queue_chan',
    blue_team: BLUE,
    orange_team: ORANGE,
    rl_name: 'RL42',
    rl_pass: '317',
    text_channel_id: `text_${Date.now()}_${Math.random()}`,
    blue_voice_id: 'vc_blue',
    orange_voice_id: 'vc_orange',
    queue_channel_id: 'queue_chan',
    ...overrides,
  });
  updateMatch(match.match_id, {
    state: 'COMPLETED',
    winner: 'BLUE',
    completed_at: new Date(Date.now() - agoMs).toISOString(),
  });
  return match.match_id;
}

/**
 * A client where only the ids in `existing` resolve to a channel. Every resolved channel
 * records its own deletion, which is what the sweep is meant to cause.
 */
function clientWithChannels(existing: string[]) {
  const deleted: string[] = [];
  const fetch = async (id: string) =>
    existing.includes(id) ? { id, delete: async () => { deleted.push(id); } } : null;
  return {
    client: {
      // The sweep checks existence through the client; deleteMatchChannels goes through
      // the guild. Both see the same channels.
      channels: { fetch },
      guilds: { fetch: async () => ({ channels: { fetch } }) },
      users: { fetch: async () => null },
      user: { id: 'bot_1' },
    } as any,
    deleted,
  };
}

describe('orphaned match channels', () => {
  beforeEach(() => {
    db.exec('DELETE FROM matches; DELETE FROM active_queues;');
    seedGuildDefaults(db, G);
  });

  afterEach(() => {
    // Timers scheduled by tests must not outlive them.
    for (const row of db.prepare('SELECT match_id FROM matches').all() as { match_id: number }[]) {
      cancelMatchChannelDeletion(row.match_id);
    }
  });

  describe('the candidate query', () => {
    it('returns finished matches with channel ids inside the window, oldest first', () => {
      const recent = finishedMatch(HOUR);
      const older = finishedMatch(2 * HOUR);

      const ids = getRecentlyFinishedMatchesWithChannels(24 * HOUR).map(m => m.match_id);
      expect(ids).toEqual([recent, older].sort((a, b) => a - b));
    });

    it('excludes matches that finished before the window', () => {
      finishedMatch(30 * HOUR);
      expect(getRecentlyFinishedMatchesWithChannels(24 * HOUR)).toEqual([]);
    });

    it('excludes live matches and ones with no channel ids left', () => {
      const live = createMatch({
        guild_id: G, channel_id: 'queue_chan', blue_team: BLUE, orange_team: ORANGE,
        rl_name: 'RL1', rl_pass: '1', text_channel_id: 'text_live',
      });
      expect(live.state).not.toBe('COMPLETED');
      finishedMatch(HOUR, { text_channel_id: '', blue_voice_id: '', orange_voice_id: '' });

      expect(getRecentlyFinishedMatchesWithChannels(24 * HOUR)).toEqual([]);
    });
  });

  describe('the sweep', () => {
    it('deletes only channels that still exist', async () => {
      const gone = finishedMatch(HOUR, { text_channel_id: 'text_gone' });
      const standing = finishedMatch(HOUR, { text_channel_id: 'text_standing' });
      const { client, deleted } = clientWithChannels(['text_standing']);

      await sweepOrphanedMatchChannels(client);

      expect(deleted).toContain('text_standing');
      expect(deleted).not.toContain('text_gone');
      expect(gone).not.toBe(standing);
    });

    it('leaves a match alone while a teardown is still pending in this process', async () => {
      finishedMatch(HOUR, { text_channel_id: 'text_pending' });
      const pendingId = (db.prepare('SELECT match_id FROM matches').get() as { match_id: number }).match_id;
      const { client, deleted } = clientWithChannels(['text_pending']);
      scheduleMatchChannelDeletion(client, pendingId, 60_000);

      await sweepOrphanedMatchChannels(client);

      expect(deleted).toEqual([]);
    });

    it('leaves a channel alone when a live rematch is running in it', async () => {
      finishedMatch(HOUR, { text_channel_id: 'text_series' });
      createMatch({
        guild_id: G, channel_id: 'queue_chan', blue_team: BLUE, orange_team: ORANGE,
        rl_name: 'RL2', rl_pass: '2', text_channel_id: 'text_series', state: 'IN_PROGRESS',
      });
      const { client, deleted } = clientWithChannels(['text_series']);

      await sweepOrphanedMatchChannels(client);

      expect(deleted).toEqual([]);
    });

    it('respects the grace period a running process asks for', async () => {
      finishedMatch(30_000, { text_channel_id: 'text_fresh' });
      const { client, deleted } = clientWithChannels(['text_fresh']);

      // Thirty seconds old is inside a live rematch window, not an orphan.
      await sweepOrphanedMatchChannels(client, 10 * 60 * 1000);
      expect(deleted).toEqual([]);

      // On startup no timer survived, so the same channel is fair game.
      await sweepOrphanedMatchChannels(client, 0);
      expect(deleted).toContain('text_fresh');
    });
  });
});
