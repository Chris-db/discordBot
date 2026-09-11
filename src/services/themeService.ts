import db from '../database/db';
import {
  Palette,
  ThemeOverrides,
  ThemeToken,
  THEME_PRESETS,
  resolvePalette,
  withPalette,
} from '../ui/palette';
import { getGuildDivisionNames, withDivisionNames } from './divisionNames';

/**
 * Per-server colour themes for the image cards.
 *
 * A server's overrides live in `guild_themes` as JSON; the resolved palette is cached
 * here so the hot path (every card render) never touches the database. Writes go
 * through this module and drop the cache entry.
 *
 * `withGuildTheme` is the entry point everything else uses: the interaction handlers,
 * the chat listener and the per-guild background loops wrap their work in it, and every
 * card drawn inside -- including on timers scheduled inside -- comes out in that
 * server's colours.
 */

const cache = new Map<string, Palette>();

export function getGuildOverrides(guildId: string): ThemeOverrides {
  const row = db.prepare('SELECT theme FROM guild_themes WHERE guild_id = ?').get(guildId) as
    | { theme: string }
    | undefined;
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.theme);
    return parsed && typeof parsed === 'object' ? (parsed as ThemeOverrides) : {};
  } catch {
    return {};
  }
}

export function getGuildPalette(guildId: string): Palette {
  let palette = cache.get(guildId);
  if (!palette) {
    palette = resolvePalette(getGuildOverrides(guildId));
    cache.set(guildId, palette);
  }
  return palette;
}

function saveOverrides(guildId: string, overrides: ThemeOverrides): void {
  db.prepare(
    `INSERT INTO guild_themes (guild_id, theme, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(guild_id) DO UPDATE SET theme = excluded.theme, updated_at = CURRENT_TIMESTAMP`
  ).run(guildId, JSON.stringify(overrides));
  cache.delete(guildId);
}

/** Sets one token. `hex` must already be normalised (`#rrggbb`). */
export function setGuildToken(guildId: string, token: ThemeToken, hex: string): void {
  saveOverrides(guildId, { ...getGuildOverrides(guildId), [token]: hex });
}

/** Clears one token, or every token when none is given. */
export function resetGuildTheme(guildId: string, token?: ThemeToken): void {
  if (!token) {
    saveOverrides(guildId, {});
    return;
  }
  const overrides = { ...getGuildOverrides(guildId) };
  delete overrides[token];
  saveOverrides(guildId, overrides);
}

/** Replaces the server's overrides with a preset's. Returns false for an unknown name. */
export function applyGuildPreset(guildId: string, name: string): boolean {
  const preset = THEME_PRESETS[name];
  if (!preset) return false;
  saveOverrides(guildId, { ...preset });
  return true;
}

/**
 * Runs `fn` with the guild's palette and division names current. A missing guild id
 * means the defaults for both.
 */
export function withGuildTheme<T>(guildId: string | null | undefined, fn: () => T): T {
  if (!guildId) return fn();
  return withPalette(getGuildPalette(guildId), () => withDivisionNames(getGuildDivisionNames(guildId), fn));
}

/** For tests and hot reloads. */
export function clearThemeCache(): void {
  cache.clear();
}
