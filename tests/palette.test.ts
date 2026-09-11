import { describe, it, expect } from 'vitest';
import { DEFAULT_PALETTE, alpha, overlay } from '../src/ui/palette';

const HEX = /^#[0-9a-f]{6}$/;

function leaves(obj: unknown, path = ''): Array<[string, string]> {
  if (typeof obj === 'string') return [[path, obj]];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
}

describe('palette', () => {
  it('every token is a 6-digit lowercase hex, except the one stored rgba', () => {
    for (const [path, value] of leaves(DEFAULT_PALETTE)) {
      if (path === 'history.row') {
        expect(value).toMatch(/^rgba\(/);
      } else {
        expect(value, path).toMatch(HEX);
      }
    }
  });

  it('alpha() and overlay() produce the exact spacing the cards were drawn with', () => {
    // Byte-identical renders depend on the canvas parsing the same string as before.
    expect(alpha('#00e676', 0.08)).toBe('rgba(0, 230, 118, 0.08)');
    expect(alpha('#ff9100', 0.15)).toBe('rgba(255, 145, 0, 0.15)');
    expect(overlay(0.08)).toBe('rgba(255, 255, 255, 0.08)');
    expect(() => alpha('red', 0.5)).toThrow();
  });
});
