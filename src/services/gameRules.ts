/**
 * Game rules shared by the match and rematch flows.
 *
 * These live in their own module rather than on matchService so rematchService can use
 * them without the two importing each other.
 */

/**
 * Votes needed to settle a result, a cancel, or a rematch — a strict majority of the
 * lobby. 3 of 4 at 2v2, 4 of 6 at 3v3, 5 of 8 at 4v4.
 */
export function majorityOf(rosterSize: number): number {
  return Math.floor(rosterSize / 2) + 1;
}

/** How long a finished match's channels stay open for a rematch before teardown. */
export const REMATCH_WINDOW_MS = 90_000;

/**
 * Votes needed from a specific roster.
 *
 * Test bots never click anything, so a lobby padded with them could never reach the
 * majority -- the same trap the gamble flow fell into by requiring everyone.
 */
export function votesRequiredFor(roster: string[]): number {
  const humans = roster.filter(id => !id.startsWith('test_bot_'));
  return Math.min(majorityOf(roster.length), Math.max(1, humans.length));
}
