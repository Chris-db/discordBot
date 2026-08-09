/**
 * How long a match took, as "12m 34s".
 *
 * The result card and the history card both show this, and they used to format it
 * independently -- a fix to one silently left the other reading differently for the same
 * match. Both timestamps are written as ISO strings (never SQLite's CURRENT_TIMESTAMP),
 * so a plain Date subtraction is safe here.
 *
 * Returns undefined rather than a placeholder when the pair is missing or nonsensical:
 * matches predating started_at, and clock skew that lands completed_at first, have nothing
 * truthful to show, and callers are expected to draw nothing at all in that case.
 */
export function formatMatchDuration(
  startedAt?: string,
  completedAt?: string
): string | undefined {
  if (!startedAt || !completedAt) return undefined;

  const secs = Math.floor(
    (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000
  );
  if (!Number.isFinite(secs) || secs < 0) return undefined;

  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
