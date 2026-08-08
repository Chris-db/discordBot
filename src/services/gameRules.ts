/**
 * Game rules shared by the match and rematch flows.
 *
 * These live in their own module rather than on matchService so rematchService can use
 * them without the two importing each other.
 */

/** Votes needed to settle a result, a cancel, or a rematch — a majority of the 6 players. */
export const REPORT_VOTES_REQUIRED = 4;

/** How long a finished match's channels stay open for a rematch before teardown. */
export const REMATCH_WINDOW_MS = 90_000;

/**
 * Votes needed from a specific roster.
 *
 * Test bots never click anything, so a lobby padded with them could never reach a flat
 * threshold of 4 -- the same trap the gamble flow fell into by requiring all 6.
 */
export function votesRequiredFor(roster: string[]): number {
  const humans = roster.filter(id => !id.startsWith('test_bot_'));
  return Math.min(REPORT_VOTES_REQUIRED, Math.max(1, humans.length));
}
