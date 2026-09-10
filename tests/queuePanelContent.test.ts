import { describe, it, expect } from 'vitest';
import { queuePanelContent } from '../src/services/queuePanel';
import { ActiveQueue } from '../src/database/queries';

const queue = (ids: string[], joinTimes: Record<string, number>, teamSize = 3): ActiveQueue => ({
  channel_id: 'c',
  guild_id: 'g',
  team_size: teamSize,
  player_ids: ids,
  player_join_times: joinTimes,
  state: 'WAITING',
  vote_counts: {},
});

describe('queuePanelContent', () => {
  it('says nothing for an empty queue', () => {
    expect(queuePanelContent(queue([], {}))).toBe('');
  });

  it('says nothing once the queue is full -- it is popping, not waiting', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const times = Object.fromEntries(ids.map(id => [id, 1_000_000]));
    expect(queuePanelContent(queue(ids, times))).toBe('');
  });

  it('reports the earliest join as a live Discord timestamp and the players still needed', () => {
    const text = queuePanelContent(queue(['a', 'b'], { a: 1_700_000_000_000, b: 1_700_000_500_000 }));
    expect(text).toContain('<t:1700000000:R>');
    expect(text).toContain('**4** more to pop');
  });

  it('uses the ladder size, not 3v3, for how many are missing', () => {
    expect(queuePanelContent(queue(['a'], { a: 1_700_000_000_000 }, 2))).toContain('**3** more');
    expect(queuePanelContent(queue(['a'], { a: 1_700_000_000_000 }, 4))).toContain('**7** more');
  });

  it('treats a player with no recorded join time as having just joined', () => {
    const before = Math.floor(Date.now() / 1000);
    const text = queuePanelContent(queue(['a'], {}));
    const stamp = Number(/<t:(\d+):R>/.exec(text)![1]);
    expect(stamp).toBeGreaterThanOrEqual(before);
  });
});
