import { describe, it, expect, beforeEach } from 'vitest';
import { getCachedAvatarImage, clearAvatarCache } from '../src/utils/avatarCache';

describe('Avatar Cache Utility', () => {
  beforeEach(() => {
    clearAvatarCache();
  });

  it('returns null immediately for test_bot_ users without network requests', async () => {
    const mockClient = {
      users: {
        fetch: () => {
          throw new Error('Should not fetch test_bot_');
        },
      },
    } as any;

    const res = await getCachedAvatarImage(mockClient, 'test_bot_12345', 128);
    expect(res).toBeNull();
  });

  it('caches successful avatar fetches and returns from cache on subsequent calls', async () => {
    let fetchCount = 0;
    const mockUser = {
      displayAvatarURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    };
    const mockClient = {
      users: {
        fetch: async () => {
          fetchCount++;
          return mockUser;
        },
      },
    } as any;

    const img1 = await getCachedAvatarImage(mockClient, 'discord_user_1', 128);
    const img2 = await getCachedAvatarImage(mockClient, 'discord_user_1', 128);

    expect(img1).toBeDefined();
    expect(img2).toBe(img1);
    expect(fetchCount).toBe(1); // Second call served from cache without calling fetch()
  });
});

describe('avatar fetch deadline', () => {
  beforeEach(() => clearAvatarCache());

  const hangingClient = {
    users: { fetch: () => new Promise(() => {}) }, // never resolves, like a stalled CDN route
  } as any;

  it('gives up after the deadline and draws initials instead of hanging the card', async () => {
    const started = Date.now();
    const img = await getCachedAvatarImage(hangingClient, 'slow_user', 128, 50);
    expect(img).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('remembers the miss so the next card does not pay the wait again', async () => {
    await getCachedAvatarImage(hangingClient, 'slow_user', 128, 50);
    const started = Date.now();
    const again = await getCachedAvatarImage(hangingClient, 'slow_user', 128, 5000);
    expect(again).toBeNull();
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('a failed user lookup is a miss, not a crash', async () => {
    const client = { users: { fetch: async () => { throw new Error('Unknown User'); } } } as any;
    expect(await getCachedAvatarImage(client, 'gone_user', 128, 500)).toBeNull();
  });
});
