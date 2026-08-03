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
