import { describe, it, expect } from 'vitest';
import { formatMatchDuration } from '../src/utils/duration';

const at = (iso: string) => new Date(iso).toISOString();

describe('formatMatchDuration', () => {
  it('formats a normal match as minutes and seconds', () => {
    expect(formatMatchDuration(at('2026-08-09T10:00:00Z'), at('2026-08-09T10:08:34Z'))).toBe(
      '8m 34s'
    );
  });

  it('keeps counting in minutes past the hour, matching the result card', () => {
    expect(formatMatchDuration(at('2026-08-09T10:00:00Z'), at('2026-08-09T12:04:00Z'))).toBe(
      '124m 0s'
    );
  });

  it('floors sub-second remainders rather than rounding up', () => {
    expect(formatMatchDuration(at('2026-08-09T10:00:00Z'), at('2026-08-09T10:00:59.900Z'))).toBe(
      '0m 59s'
    );
  });

  // Matches created before started_at existed, and rows that never reached IN_PROGRESS,
  // carry no start. The cards draw nothing at all rather than inventing a number.
  it('returns undefined when either timestamp is missing', () => {
    expect(formatMatchDuration(undefined, at('2026-08-09T10:00:00Z'))).toBeUndefined();
    expect(formatMatchDuration(at('2026-08-09T10:00:00Z'), undefined)).toBeUndefined();
    expect(formatMatchDuration(undefined, undefined)).toBeUndefined();
  });

  it('returns undefined when the clock ran backwards', () => {
    expect(formatMatchDuration(at('2026-08-09T10:08:00Z'), at('2026-08-09T10:00:00Z'))).toBeUndefined();
  });

  it('returns undefined for an unparseable timestamp instead of "NaNm NaNs"', () => {
    expect(formatMatchDuration('not-a-date', at('2026-08-09T10:00:00Z'))).toBeUndefined();
    expect(formatMatchDuration(at('2026-08-09T10:00:00Z'), 'not-a-date')).toBeUndefined();
  });
});
