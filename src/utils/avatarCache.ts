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
 * The most a card will wait for one avatar. The download used to be unbounded, so a slow
 * route to Discord's CDN held every card that needed a fresh avatar for as long as the
 * CDN took -- the ready-check card simply never appeared one evening -- while cards with
 * no real players (test bots skip the fetch) stayed instant. Past this, the card draws
 * the player's initial instead.
 */
export const AVATAR_FETCH_TIMEOUT_MS = 4_000;

/** A failed or timed-out fetch is remembered briefly so a bad CDN costs one wait, not one per card. */
const MISS_TTL_MS = 60 * 1000;
const recentMisses = new Map<string, number>();

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
  size: 128 | 256 = 128,
  timeoutMs: number = AVATAR_FETCH_TIMEOUT_MS
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
  const missedAt = recentMisses.get(cacheKey);
  if (missedAt !== undefined && now - missedAt < MISS_TTL_MS) {
    return null;
  }

  try {
    // One deadline over both round trips (user lookup, then the image bytes).
    const img = await withTimeout(fetchAvatar(client, discordId, size), timeoutMs);
    pruneCache(now);
    avatarCache.set(cacheKey, { img, timestamp: now });
    recentMisses.delete(cacheKey);
    return img;
  } catch (err) {
    recentMisses.set(cacheKey, now);
    logger.warn(`Avatar for user ${discordId} unavailable (${(err as Error).message}); drawing initials for the next minute.`);
    return null;
  }
}

async function fetchAvatar(client: Client, discordId: string, size: 128 | 256): Promise<Image> {
  const user = await client.users.fetch(discordId);
  const url = user.displayAvatarURL({ extension: 'png', size });
  // loadImage(url) does its own download with no way to abort it; fetching the bytes here
  // keeps the whole thing under the one timeout.
  const res = await fetch(url, { signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CDN returned ${res.status}`);
  return loadImage(Buffer.from(await res.arrayBuffer()));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Starts loading an avatar without waiting for it. Called when a player joins a queue,
 * so the ready-check and match cards a few minutes later find it already cached.
 */
export function prefetchAvatar(client: Client, discordId: string): void {
  void getCachedAvatarImage(client, discordId).catch(() => null);
}

/**
 * Clears the avatar image cache (useful for tests).
 */
export function clearAvatarCache(): void {
  avatarCache.clear();
  recentMisses.clear();
}
