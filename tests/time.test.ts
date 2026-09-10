import { describe, it, expect } from 'vitest';
import db from '../src/database/db';
import { parseDbTimestamp, toDiscordTimestamp } from '../src/utils/time';

describe('parseDbTimestamp', () => {
  it('reads a bare SQLite CURRENT_TIMESTAMP as UTC, not local', () => {
    // The bug: `new Date('2026-08-09 09:03:13')` is parsed as local time, so on any host
    // east of Greenwich the value comes back earlier than it actually was.
    expect(parseDbTimestamp('2026-08-09 09:03:13')).toBe(
      Date.UTC(2026, 7, 9, 9, 3, 13)
    );
  });

  it('still handles the ISO strings the code writes itself', () => {
    expect(parseDbTimestamp('2026-08-09T09:03:13.523Z')).toBe(
      new Date('2026-08-09T09:03:13.523Z').getTime()
    );
  });

  it('honours an explicit offset rather than forcing UTC onto it', () => {
    expect(parseDbTimestamp('2026-08-09T11:03:13+02:00')).toBe(
      Date.UTC(2026, 7, 9, 9, 3, 13)
    );
  });

  it('returns NaN for missing or unparseable values instead of 1970', () => {
    for (const bad of [undefined, null, '', 'not a date']) {
      expect(Number.isNaN(parseDbTimestamp(bad)), String(bad)).toBe(true);
    }
  });

  it('agrees with SQLite about what "now" is', () => {
    // The real invariant: a row SQLite has just stamped must not look old to us.
    const now = db.prepare("SELECT CURRENT_TIMESTAMP AS t").get() as { t: string };
    const ageMs = Date.now() - parseDbTimestamp(now.t);

    // CURRENT_TIMESTAMP truncates to the second, so allow a small window either way --
    // but nothing like the two hours the local-time parse produced.
    expect(Math.abs(ageMs)).toBeLessThan(5000);
  });

  it('would have caught the auto-cancel bug', () => {
    // Match #8: created 09:03:13, swept at 09:04:00. The sweeper cancels anything in setup
    // older than 15 minutes, and reported this one as 121 minutes old.
    const created = '2026-08-09 09:03:13';
    const sweptAt = new Date('2026-08-09T09:04:00.934Z').getTime();
    const ageMins = (sweptAt - parseDbTimestamp(created)) / 60_000;

    expect(ageMins).toBeLessThan(15);
  });
});

describe('toDiscordTimestamp', () => {
  it('gives whole seconds for <t:...> markup', () => {
    expect(toDiscordTimestamp('2026-08-09 09:03:13')).toBe(
      Math.floor(Date.UTC(2026, 7, 9, 9, 3, 13) / 1000)
    );
  });

  it('is undefined rather than NaN when there is nothing to show', () => {
    // `<t:NaN:R>` renders as literal broken text in Discord.
    expect(toDiscordTimestamp(null)).toBeUndefined();
    expect(toDiscordTimestamp('rubbish')).toBeUndefined();
  });
});
