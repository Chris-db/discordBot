import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Every colour the image cards draw with, in one place.
 *
 * Until 2026-09-11 these were ~200 hex literals spread over ten image files, and each
 * tweak meant finding the right line. Now a card asks for `P.text` or `P.team.blue`, and
 * a server can later swap the values without touching any drawing code (that is step
 * two, `/theme`; this file is step one and changed no pixel -- proven by rendering every
 * card before and after with scripts/renderAll.ts and diffing the PNGs).
 *
 * Two tiers of token:
 *
 * - The flat names at the top (`accent`, `text`, `card`, `team.*`, `division.*`) are the
 *   ones a theme will expose. Keep this list short; a theme is a dozen choices, not fifty.
 * - The nested groups further down (`queueBg`, `matchVs`, `gamble`, `leaderboard`,
 *   `history`) are card-specific shades that existed before this file. They are named so
 *   they can be found, and a theme may derive them later, but they are not the public
 *   surface.
 *
 * Alpha variants are made with `alpha()` rather than stored, so an overridden base colour
 * carries its tints with it.
 */

export interface Palette {
  /** The bot's default highlight -- cyan. Titles, MMR figures, Balanced-vote card. */
  accent: string;
  /** "Go": queue full, player ready, positive MMR delta, a win. */
  positive: string;
  /** Negative MMR delta, a loss, the Double-or-Nothing jackpot. */
  negative: string;
  /** Captains, promotion zone, Rank S. */
  gold: string;
  /** Leaderboard heading, average-time stat, the match card's centre badge. */
  amber: string;
  /** Mode-vote heading, available draft picks, Rank A. */
  purple: string;
  /** "Not yet": a player still missing from the ready check. */
  warning: string;
  /** The lighter sky-blue used for stat figures: leaderboard MMR, win rate, the VS card's blue side. */
  sky: string;
  /** Background gradient, top and bottom, on most cards. */
  bgTop: string;
  bgBottom: string;
  /** A filled card, an empty slot, and the surface used for avatar fallbacks and idle borders. */
  card: string;
  cardEmpty: string;
  surface: string;
  /** Text, from brightest to dimmest. */
  text: string;
  textMuted: string;
  textFaint: string;
  textDim: string;
  /** Pure black and white, for initials on avatars and text on a coloured chip. */
  black: string;
  white: string;
  team: {
    blue: string;
    orange: string;
  };
  division: Record<'C' | 'B' | 'A' | 'X' | 'S', string>;
  streak: {
    /** 3+, 5+, 10+ wins. */
    hot: string;
    blazing: string;
    unstoppable: string;
  };
  zone: {
    promotion: string;
    relegation: string;
  };

  /** The queue panel sits on a deeper slate than the other cards. */
  queueBg: { top: string; bottom: string };
  /** The pre-match VS card: navy fading to burnt orange; its blue side is `sky`. */
  matchVs: { bgTop: string; bgMid: string; bgBottom: string; orange: string };
  /** The Double-or-Nothing result: stone for an inversion, deep red for a jackpot. */
  gamble: {
    stoneTop: string; stoneBottom: string;
    redTop: string; redBottom: string;
    invertedText: string; doubledText: string;
  };
  leaderboard: { medalGold: string; medalSilver: string; medalBronze: string };
  history: { row: string; series: string; teamText: string };
}

export const DEFAULT_PALETTE: Palette = {
  accent: '#00b0ff',
  positive: '#00e676',
  negative: '#ff1744',
  gold: '#ffd700',
  amber: '#f59e0b',
  purple: '#aa00ff',
  warning: '#ff9100',
  sky: '#38bdf8',
  bgTop: '#0f172a',
  bgBottom: '#1e293b',
  card: '#1e293b',
  cardEmpty: '#0f172a',
  surface: '#334155',
  text: '#f8fafc',
  textMuted: '#94a3b8',
  textFaint: '#64748b',
  textDim: '#475569',
  black: '#000000',
  white: '#ffffff',
  team: {
    blue: '#00b0ff',
    orange: '#ff9100',
  },
  division: {
    C: '#00e676', // Green  (Diamond / Champ 1)
    B: '#2979ff', // Blue   (Champ 2 / Champ 3)
    A: '#aa00ff', // Purple (GC1 / GC2)
    X: '#ff8f00', // Amber  (GC3 / Low SSL)
    S: '#ffd700', // Gold   (SSL / Pro)
  },
  streak: {
    hot: '#ffab00',
    blazing: '#ff6d00',
    unstoppable: '#ff1744',
  },
  zone: {
    promotion: '#00e676', // The arrow up. Green, same as a positive delta.
    relegation: '#ff5252', // The arrow down.
  },

  queueBg: { top: '#0b0f19', bottom: '#111827' },
  matchVs: { bgTop: '#0a192f', bgMid: '#0f172a', bgBottom: '#2c140d', orange: '#fb923c' },
  gamble: {
    stoneTop: '#1c1917', stoneBottom: '#292524',
    redTop: '#450a0a', redBottom: '#1e1b18',
    invertedText: '#facc15', doubledText: '#ff6e40',
  },
  leaderboard: { medalGold: '#fbbf24', medalSilver: '#e2e8f0', medalBronze: '#d97706' },
  history: { row: 'rgba(30, 41, 59, 0.8)', series: '#a78bfa', teamText: '#cbd5e1' },
};

/** The palette every card draws with: the current context's, else the default (see below). */
export const P: Palette = new Proxy({} as Palette, {
  get: (_target, key) => (currentPalette() as unknown as Record<string | symbol, unknown>)[key],
  ownKeys: () => Reflect.ownKeys(currentPalette()),
  getOwnPropertyDescriptor: (_target, key) => ({ enumerable: true, configurable: true, value: (currentPalette() as unknown as Record<string | symbol, unknown>)[key] }),
});

/**
 * `alpha('#00e676', 0.08)` -> `'rgba(0, 230, 118, 0.08)'`. The spacing matches the
 * literals the cards used to carry, so a pre-refactor render is byte-identical.
 */
export function alpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`alpha() needs a 6-digit hex colour, got "${hex}"`);
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
}

/** A white overlay, the cards' usual way of lifting a surface: `overlay(0.08)`. */
export const overlay = (a: number): string => `rgba(255, 255, 255, ${a})`;

// ---------------------------------------------------------------------------------------
// Per-server themes
// ---------------------------------------------------------------------------------------

/**
 * The tokens a server may override with /theme. Dotted paths into the palette. Kept to
 * the choices that change how the bot looks, not every shade -- and under Discord's
 * limit of 25 choices per option, so the command can offer them as a dropdown.
 */
export const THEME_TOKENS = [
  'accent', 'positive', 'negative', 'gold', 'amber', 'purple', 'warning', 'sky',
  'bgTop', 'bgBottom', 'card', 'cardEmpty', 'surface', 'text', 'textMuted',
  'team.blue', 'team.orange',
  'division.C', 'division.B', 'division.A', 'division.X', 'division.S',
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

/** Overrides as stored: a flat map of token -> hex. Anything absent is the default. */
export type ThemeOverrides = Partial<Record<ThemeToken, string>>;

export const HEX_COLOUR = /^#[0-9a-f]{6}$/;

/** `"FF9100"`, `"#ff9100"` and `" #FF9100 "` all become `"#ff9100"`; anything else is null. */
export function normaliseHex(input: string): string | null {
  const s = input.trim().toLowerCase();
  const withHash = s.startsWith('#') ? s : `#${s}`;
  return HEX_COLOUR.test(withHash) ? withHash : null;
}

/** A few starting points. `default` is the palette above; the rest override a handful of tokens. */
export const THEME_PRESETS: Record<string, ThemeOverrides> = {
  default: {},
  // Greys with the team colours left alone: for a server that finds the cyan loud.
  mono: {
    accent: '#e2e8f0', sky: '#e2e8f0',
    bgTop: '#09090b', bgBottom: '#18181b', card: '#18181b', cardEmpty: '#09090b', surface: '#27272a',
  },
  // Deeper, bluer night.
  midnight: {
    accent: '#60a5fa', sky: '#93c5fd',
    bgTop: '#020617', bgBottom: '#0f172a', card: '#0f172a', cardEmpty: '#020617', surface: '#1e293b',
  },
  // Warm: stone backgrounds and an orange accent.
  ember: {
    accent: '#fb923c', sky: '#fdba74', amber: '#f97316',
    bgTop: '#1c1917', bgBottom: '#292524', card: '#292524', cardEmpty: '#1c1917', surface: '#44403c',
  },
};

/** Builds a full palette from the defaults plus a set of overrides. Unknown keys are ignored. */
export function resolvePalette(overrides: ThemeOverrides): Palette {
  const palette: Palette = JSON.parse(JSON.stringify(DEFAULT_PALETTE));
  for (const token of THEME_TOKENS) {
    const value = overrides[token];
    if (!value || !HEX_COLOUR.test(value)) continue;
    const [group, key] = token.split('.') as [keyof Palette, string | undefined];
    if (key) (palette[group] as unknown as Record<string, string>)[key] = value;
    else (palette as unknown as Record<string, string>)[group] = value;
  }
  // The queue panel has its own, slightly deeper background by default. A server that
  // sets the backgrounds means "the backgrounds", so the panel follows.
  if (overrides.bgTop && HEX_COLOUR.test(overrides.bgTop)) palette.queueBg.top = overrides.bgTop;
  if (overrides.bgBottom && HEX_COLOUR.test(overrides.bgBottom)) palette.queueBg.bottom = overrides.bgBottom;
  return palette;
}

/** Reads one token's value out of a palette, for /theme list. */
export function readToken(palette: Palette, token: ThemeToken): string {
  const [group, key] = token.split('.') as [keyof Palette, string | undefined];
  const value = palette[group];
  return key ? (value as unknown as Record<string, string>)[key] : (value as string);
}

// The palette a card draws with is whichever one the current async context was started
// with -- an interaction handler runs inside its guild's theme, and timers it schedules
// inherit it. Outside any context (boot, tests) it is the default. Nothing that draws
// needs to know: `P.text` resolves at the moment it is read.
const paletteContext = new AsyncLocalStorage<Palette>();

export function currentPalette(): Palette {
  return paletteContext.getStore() ?? DEFAULT_PALETTE;
}

export function withPalette<T>(palette: Palette, fn: () => T): T {
  return paletteContext.run(palette, fn);
}
