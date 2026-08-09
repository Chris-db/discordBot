/**
 * Parsing timestamps that come back out of SQLite.
 *
 * The database holds two different shapes in the same columns:
 *
 *   created_at   "2026-08-09 09:03:13"       SQLite CURRENT_TIMESTAMP -- UTC, no zone marker
 *   started_at   "2026-08-09T09:03:13.523Z"  JS toISOString()         -- UTC, explicit Z
 *
 * `new Date()` treats the first form as **local time**, because a space-separated string
 * without a zone is not ISO 8601 and falls back to implementation-defined parsing. On a
 * UTC+2 machine that reads every CURRENT_TIMESTAMP as two hours earlier than it was.
 *
 * That is not cosmetic. sweepStaleMatches compares a match's age against a 15-minute
 * setup timeout, so a match created seconds ago looked 121 minutes old and was
 * auto-cancelled mid-vote — reproducibly, for anyone east of Greenwich.
 */

/** True for "YYYY-MM-DD HH:MM:SS" with no timezone -- SQLite's CURRENT_TIMESTAMP shape. */
const BARE_SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * Parses a timestamp read from the database, in UTC.
 *
 * Handles both shapes above. Returns NaN for anything unparseable, so callers can guard
 * with Number.isNaN rather than silently treating a bad row as 1970.
 */
export function parseDbTimestamp(value?: string | null): number {
  if (!value) return NaN;

  // Already carries a zone (trailing Z, or +02:00 / -05:00) -- Date handles it correctly.
  const normalised = BARE_SQLITE_TIMESTAMP.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  return new Date(normalised).getTime();
}

/** Seconds since epoch, for Discord's `<t:...>` markup. NaN-safe: returns undefined. */
export function toDiscordTimestamp(value?: string | null): number | undefined {
  const ms = parseDbTimestamp(value);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}
