import { AsyncLocalStorage } from 'node:async_hooks';
import db from '../database/db';
import { DEFAULT_TEAM_SIZE } from '../database/migrations';

/**
 * Per-server division names for the cards.
 *
 * `guild_divisions.display_name` is what `/division list` and the sidebar use, but the
 * image cards took their "Rank C" from a hard-coded table -- so a server that names its
 * only ladder "6mans" still saw "1000 MMR (Rank C)" on every card. The names now ride
 * along in the same request context as the palette (`withGuildTheme` sets both), and
 * `getDivisionTier` reads them from here, falling back to the built-in names outside a
 * guild context (tests, the default render script).
 *
 * Keyed by division letter, not by size: cards know a player's division but not always
 * the ladder size, and a server that renames divisions does so for all sizes at once
 * (`/setup` does; `/division configure name:` is per size, and the 3v3 row wins).
 */

export type DivisionNames = Record<string, string>;

const cache = new Map<string, DivisionNames>();
const context = new AsyncLocalStorage<DivisionNames>();

function load(guildId: string, into: DivisionNames): DivisionNames {
  for (const k of Object.keys(into)) delete into[k];
  const rows = db
    .prepare('SELECT division, display_name, team_size FROM guild_divisions WHERE guild_id = ? ORDER BY team_size ASC')
    .all(guildId) as Array<{ division: string; display_name: string; team_size: number }>;
  for (const r of rows) {
    // First row per division wins unless the 3v3 row comes along; that is the default
    // size, so it is the name most players will see.
    if (!(r.division in into) || r.team_size === DEFAULT_TEAM_SIZE) into[r.division] = r.display_name;
  }
  return into;
}

export function getGuildDivisionNames(guildId: string): DivisionNames {
  let names = cache.get(guildId);
  if (!names) {
    names = load(guildId, {});
    cache.set(guildId, names);
  }
  return names;
}

/**
 * Call after changing any display_name for the guild. Reloads the cached map *in place*:
 * a request that is already running (say, `/setup` renaming the ladder and then posting
 * the panel) holds a reference to that same object, and sees the new names at once.
 */
export function invalidateDivisionNames(guildId: string): void {
  const names = cache.get(guildId);
  if (names) load(guildId, names);
}

export function withDivisionNames<T>(names: DivisionNames, fn: () => T): T {
  return context.run(names, fn);
}

/** The current request's name for a division, or undefined outside a guild context. */
export function currentDivisionName(division: string): string | undefined {
  return context.getStore()?.[division];
}

/** For tests. */
export function clearDivisionNamesCache(): void {
  cache.clear();
}
