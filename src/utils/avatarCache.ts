import { Image, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { logger } from './logger';

interface CachedAvatar {
  img: Image;
  timestamp: number;
}

const AVATAR_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE_SIZE = 200;
const avatarCache = new Map<string, CachedAvatar>();

/**
 * Prunes expired entries and enforces MAX_CACHE_SIZE by evicting oldest avatars.
 */
function pruneCache(now: number): void {
  for (const [key, item] of avatarCache.entries()) {
    if (now - item.timestamp >= AVATAR_TTL_MS) {
      avatarCache.delete(key);
    }
  }

  if (avatarCache.size >= MAX_CACHE_SIZE) {
    const sorted = Array.from(avatarCache.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );
    const toRemove = sorted.slice(0, Math.floor(MAX_CACHE_SIZE / 4));
    for (const [key] of toRemove) {
      avatarCache.delete(key);
    }
  }
}

/**
 * Fetches and caches a Discord user's avatar as an @napi-rs/canvas Image object.
 * Returns null if the user or avatar cannot be fetched.
 */
export async function getCachedAvatarImage(
  client: Client,
  discordId: string,
  size: 128 | 256 = 128
): Promise<Image | null> {
  if (discordId.startsWith('test_bot_')) {
    return null;
  }

  const cacheKey = `${discordId}_${size}`;
  const now = Date.now();
  const cached = avatarCache.get(cacheKey);

  if (cached && now - cached.timestamp < AVATAR_TTL_MS) {
    return cached.img;
  }

  try {
    const user = await client.users.fetch(discordId).catch(() => null);
    if (!user) return null;

    const url = user.displayAvatarURL({ extension: 'png', size });
    const img = await loadImage(url);

    pruneCache(now);
    avatarCache.set(cacheKey, { img, timestamp: now });
    return img;
  } catch (err) {
    logger.warn(`Failed to load avatar image for user ${discordId}:`, err);
    return null;
  }
}

/**
 * Clears the avatar image cache (useful for tests).
 */
export function clearAvatarCache(): void {
  avatarCache.clear();
}
