import { GlobalFonts } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

/**
 * Fonts are bundled rather than taken from the host.
 *
 * Every ctx.font used to say `sans-serif`, which is a request, not a font -- whatever the
 * machine happened to have got used. On Windows that resolved to something readable but
 * with no colour emoji, so every 🏆 and 🔥 drew as a tofu box. On a bare Linux VPS or a
 * slim Docker image there is frequently no font installed at all, and the cards render
 * blank. Shipping the files makes every card look the same everywhere.
 *
 * Both fonts are SIL Open Font License 1.1, which permits redistribution.
 */
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

const TEXT_FAMILY = 'SixMansSans';
const EMOJI_FAMILY = 'SixMansEmoji';

/**
 * The family list every card should draw with.
 *
 * Skia falls back per glyph, so letters come from Inter and emoji from Noto Color Emoji
 * within a single string -- verified by rendering, not assumed.
 */
export const FONT_STACK = `${TEXT_FAMILY}, ${EMOJI_FAMILY}`;

let registered = false;

/**
 * Registers the bundled fonts. Safe to call repeatedly; runs once.
 *
 * Called at module load by `fontStack()` so image modules cannot draw before the fonts
 * exist, rather than depending on index.ts calling it first.
 */
export function registerFonts(): boolean {
  if (registered) return true;

  const files: [string, string][] = [
    [path.join(FONT_DIR, 'Inter-Variable.ttf'), TEXT_FAMILY],
    [path.join(FONT_DIR, 'NotoColorEmoji.ttf'), EMOJI_FAMILY],
  ];

  let allPresent = true;
  for (const [file, family] of files) {
    if (!fs.existsSync(file)) {
      // Not fatal: the bot is more useful with ugly cards than not running at all.
      logger.warn(`Font missing: ${file}. Cards will fall back to whatever the host has.`);
      allPresent = false;
      continue;
    }
    GlobalFonts.registerFromPath(file, family);
  }

  registered = true;
  if (allPresent) logger.info('Bundled fonts registered (Inter + Noto Color Emoji).');
  return allPresent;
}

/** Builds a canvas font string using the bundled stack, e.g. fontStack('bold 20px'). */
export function fontStack(spec: string): string {
  registerFonts();
  return `${spec} ${FONT_STACK}`;
}

// Register on import so any module that draws has the fonts available.
registerFonts();
