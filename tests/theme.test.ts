import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import {
  P,
  DEFAULT_PALETTE,
  THEME_TOKENS,
  THEME_PRESETS,
  resolvePalette,
  normaliseHex,
  readToken,
  withPalette,
  currentPalette,
} from '../src/ui/palette';
import {
  getGuildPalette,
  setGuildToken,
  resetGuildTheme,
  applyGuildPreset,
  withGuildTheme,
  clearThemeCache,
  getGuildOverrides,
} from '../src/services/themeService';
import { getDivisionTier } from '../src/services/mmrService';
import { alpha } from '../src/ui/palette';

const G1 = 'guild_theme_one';
const G2 = 'guild_theme_two';

describe('palette resolution', () => {
  it('normalises hex input and rejects anything else', () => {
    expect(normaliseHex('FF9100')).toBe('#ff9100');
    expect(normaliseHex(' #Ff9100 ')).toBe('#ff9100');
    expect(normaliseHex('#fff')).toBeNull();
    expect(normaliseHex('orange')).toBeNull();
    expect(normaliseHex('#gg9100')).toBeNull();
  });

  it('applies overrides on top of the defaults and ignores junk', () => {
    const p = resolvePalette({ accent: '#123456', 'team.blue': '#abcdef', 'division.S': '#000000', bogus: '#111111' } as any);
    expect(p.accent).toBe('#123456');
    expect(p.team.blue).toBe('#abcdef');
    expect(p.division.S).toBe('#000000');
    expect(p.text).toBe(DEFAULT_PALETTE.text);
    // The defaults object itself is never mutated.
    expect(DEFAULT_PALETTE.accent).toBe('#00b0ff');
  });

  it('every preset only touches public tokens with valid colours', () => {
    for (const [name, preset] of Object.entries(THEME_PRESETS)) {
      for (const [token, value] of Object.entries(preset)) {
        expect(THEME_TOKENS, `${name}.${token}`).toContain(token);
        expect(value, `${name}.${token}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    expect(THEME_TOKENS.length).toBeLessThanOrEqual(25); // Discord's choice limit
  });

  it('readToken walks dotted paths', () => {
    expect(readToken(DEFAULT_PALETTE, 'team.orange')).toBe('#ff9100');
    expect(readToken(DEFAULT_PALETTE, 'card')).toBe('#1e293b');
  });
});

describe('P resolves from the current context', () => {
  it('is the default outside any context', () => {
    expect(P.accent).toBe('#00b0ff');
    expect(currentPalette()).toBe(DEFAULT_PALETTE);
  });

  it('is the context palette inside, including nested groups and derived colours', () => {
    const themed = resolvePalette({ accent: '#111111', 'team.blue': '#222222', 'division.A': '#333333' });
    withPalette(themed, () => {
      expect(P.accent).toBe('#111111');
      expect(P.team.blue).toBe('#222222');
      expect(getDivisionTier('A').color).toBe('#333333');
      expect(alpha(P.accent, 0.5)).toBe('rgba(17, 17, 17, 0.5)');
    });
    expect(P.accent).toBe('#00b0ff');
    expect(getDivisionTier('A').color).toBe('#aa00ff');
  });

  it('does not bleed between two interleaved async contexts', async () => {
    const a = resolvePalette({ accent: '#aaaaaa' });
    const b = resolvePalette({ accent: '#bbbbbb' });
    const seen: string[] = [];
    const task = (palette: typeof a, tag: string) =>
      withPalette(palette, async () => {
        seen.push(`${tag}:${P.accent}`);
        await new Promise(r => setTimeout(r, 5));
        seen.push(`${tag}:${P.accent}`);
      });
    await Promise.all([task(a, 'a'), task(b, 'b')]);
    expect(seen.sort()).toEqual(['a:#aaaaaa', 'a:#aaaaaa', 'b:#bbbbbb', 'b:#bbbbbb']);
  });

  it('a timer scheduled inside a context inherits it', async () => {
    const themed = resolvePalette({ accent: '#c0ffee' });
    const later = await withPalette(
      themed,
      () => new Promise<string>(resolve => setTimeout(() => resolve(P.accent), 1))
    );
    expect(later).toBe('#c0ffee');
  });
});

describe('themeService', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM guild_themes WHERE guild_id IN ('${G1}', '${G2}')`);
    clearThemeCache();
  });

  it('stores overrides per guild and resolves them', () => {
    setGuildToken(G1, 'accent', '#123456');
    setGuildToken(G1, 'team.orange', '#654321');
    expect(getGuildOverrides(G1)).toEqual({ accent: '#123456', 'team.orange': '#654321' });
    expect(getGuildPalette(G1).accent).toBe('#123456');
    expect(getGuildPalette(G2).accent).toBe('#00b0ff');
  });

  it('a write drops the cached palette', () => {
    expect(getGuildPalette(G1).accent).toBe('#00b0ff');
    setGuildToken(G1, 'accent', '#123456');
    expect(getGuildPalette(G1).accent).toBe('#123456');
    resetGuildTheme(G1, 'accent');
    expect(getGuildPalette(G1).accent).toBe('#00b0ff');
  });

  it('a preset replaces the overrides wholesale; reset with no token clears them', () => {
    setGuildToken(G1, 'text', '#ff0000');
    expect(applyGuildPreset(G1, 'ember')).toBe(true);
    expect(getGuildOverrides(G1)).toEqual(THEME_PRESETS.ember);
    expect(applyGuildPreset(G1, 'nope')).toBe(false);
    resetGuildTheme(G1);
    expect(getGuildOverrides(G1)).toEqual({});
  });

  it('withGuildTheme runs under the guild palette, and the default for no guild', () => {
    setGuildToken(G1, 'accent', '#abcdef');
    expect(withGuildTheme(G1, () => P.accent)).toBe('#abcdef');
    expect(withGuildTheme(null, () => P.accent)).toBe('#00b0ff');
    expect(withGuildTheme(G2, () => P.accent)).toBe('#00b0ff');
  });

  it('survives a corrupt row', () => {
    db.prepare(`INSERT INTO guild_themes (guild_id, theme) VALUES (?, ?)`).run(G1, '{not json');
    expect(getGuildPalette(G1).accent).toBe('#00b0ff');
  });
});

describe('derived tokens', () => {
  it('the queue panel background follows an overridden background', () => {
    const p = resolvePalette({ bgTop: '#010101', bgBottom: '#020202' });
    expect(p.queueBg).toEqual({ top: '#010101', bottom: '#020202' });
    expect(resolvePalette({}).queueBg).toEqual(DEFAULT_PALETTE.queueBg);
  });
});
