import { Player } from '../database/queries';

export interface DraftResult {
  blueTeam: Player[];
  orangeTeam: Player[];
  matchupKey?: string;
}

/**
 * The team size implied by a roster, validated.
 *
 * Everything in here works at 2v2, 3v3 or 4v4; what it cannot do is split an odd or
 * undersized roster, so that is the only thing worth rejecting.
 */
export function teamSizeForRoster(players: Player[], what = 'This'): number {
  if (players.length < 4 || players.length % 2 !== 0) {
    throw new Error(`${what} requires an even roster of at least 4 players, got ${players.length}.`);
  }
  return players.length / 2;
}

/**
 * Computes a unique canonical string key for a matchup, invariant to which team is Blue
 * vs. Orange.
 */
export function getMatchupKey(blueTeam: Player[], orangeTeam: Player[]): string {
  const allPlayers = [...blueTeam, ...orangeTeam];
  const sortedIds = allPlayers.map(p => p.discord_id).sort();
  const refId = sortedIds[0];

  const isBlueRef = blueTeam.some(p => p.discord_id === refId);
  const teamA = isBlueRef ? blueTeam : orangeTeam;

  return teamA
    .map(p => p.discord_id)
    .sort()
    .join(',');
}

/**
 * Every unique way to split the roster into two teams.
 *
 * Pinning the lowest-id player to teamA is what makes each split appear once rather than
 * twice: it removes the Blue/Orange mirror. That leaves C(2n-1, n-1) matchups -- 3 at
 * 2v2, 10 at 3v3, 35 at 4v4.
 */
export function getAllUniqueMatchups(players: Player[]): DraftResult[] {
  const teamSize = teamSizeForRoster(players);

  const sorted = [...players].sort((a, b) => a.discord_id.localeCompare(b.discord_id));
  const refPlayer = sorted[0];
  const others = sorted.slice(1);

  const results: DraftResult[] = [];

  // Choose the teamSize-1 team-mates that join the reference player.
  const choose = (start: number, picked: number[]) => {
    if (picked.length === teamSize - 1) {
      const inTeamA = new Set(picked);
      const teamA = [refPlayer, ...picked.map(i => others[i])];
      const teamB = others.filter((_, idx) => !inTeamA.has(idx));
      results.push({
        blueTeam: teamA,
        orangeTeam: teamB,
        matchupKey: getMatchupKey(teamA, teamB),
      });
      return;
    }
    // Stop early once too few candidates remain to complete the team.
    for (let i = start; i < others.length - (teamSize - 2 - picked.length); i++) {
      picked.push(i);
      choose(i + 1, picked);
      picked.pop();
    }
  };
  choose(0, []);

  return results;
}

/**
 * The order captains pick in, as a serpentine starting with Blue.
 *
 * Blue picks first, then the turn snakes so neither captain gets consecutive first picks:
 *   2v2 -> B                  (1 pick, then the last player is auto-assigned)
 *   3v3 -> B, O, O            (the classic 1-2-1)
 *   4v4 -> B, O, O, B, B      (then the last is auto-assigned to Orange)
 *
 * The final player is never picked -- there is no choice left to make -- so the order
 * returned covers 2*teamSize - 3 picks and the caller auto-assigns the remainder.
 */
export function getPickOrder(teamSize: number): ('BLUE' | 'ORANGE')[] {
  const picksToMake = 2 * teamSize - 3;
  const order: ('BLUE' | 'ORANGE')[] = [];

  // Serpentine: 1 then 2,2,2... alternating, which is B | OO | BB | OO | ...
  let turn: 'BLUE' | 'ORANGE' = 'BLUE';
  let run = 1;
  while (order.length < picksToMake) {
    for (let i = 0; i < run && order.length < picksToMake; i++) {
      order.push(turn);
    }
    turn = turn === 'BLUE' ? 'ORANGE' : 'BLUE';
    run = 2;
  }

  return order;
}

/**
 * Returns the MMR gap between the two sides of a matchup.
 */
export function getMatchupMmrDiff(matchup: DraftResult): number {
  const blueSum = matchup.blueTeam.reduce((sum, p) => sum + p.mmr, 0);
  const orangeSum = matchup.orangeTeam.reduce((sum, p) => sum + p.mmr, 0);
  return Math.abs(blueSum - orangeSum);
}

/**
 * Every unique matchup ordered from most to least balanced.
 */
export function rankMatchupsByBalance(players: Player[]): DraftResult[] {
  return getAllUniqueMatchups(players).sort(
    (a, b) => getMatchupMmrDiff(a) - getMatchupMmrDiff(b)
  );
}

/**
 * Splits the roster into two even teams to minimize average MMR difference.
 *
 * Balanced mode has only one optimal answer, so a re-roll needs somewhere to go: passing
 * the matchups already shown walks down the ranking to the next-closest split rather than
 * handing back the same teams (or silently falling back to a random pairing).
 */
export function createBalancedTeams(players: Player[], seenMatchups: string[] = []): DraftResult {
  teamSizeForRoster(players, 'Balanced teams');

  const ranked = rankMatchupsByBalance(players);
  // Once every matchup has been shown, start again from the most balanced split.
  const chosen = ranked.find(m => !seenMatchups.includes(m.matchupKey!)) || ranked[0];

  // getAllUniqueMatchups always puts the lowest discord_id on teamA, which would otherwise
  // make the same player Blue in every balanced match.
  const swapColors = Math.random() > 0.5;

  return {
    blueTeam: swapColors ? chosen.orangeTeam : chosen.blueTeam,
    orangeTeam: swapColors ? chosen.blueTeam : chosen.orangeTeam,
    matchupKey: chosen.matchupKey,
  };
}

/**
 * Shuffles the roster randomly into two even teams without repeating any previously seen
 * matchup until every unique matchup has been exhausted.
 */
export function createRandomTeams(players: Player[], seenMatchups: string[] = []): DraftResult {
  teamSizeForRoster(players, 'Random teams');

  const allMatchups = getAllUniqueMatchups(players);
  let available = allMatchups.filter(m => !seenMatchups.includes(m.matchupKey!));

  // Every matchup has already been shown -- start the cycle again.
  if (available.length === 0) {
    available = allMatchups;
  }

  const chosen = available[Math.floor(Math.random() * available.length)];

  // 50% chance to swap Blue and Orange team colors for variety
  const swapColors = Math.random() > 0.5;
  const blueTeam = swapColors ? chosen.orangeTeam : chosen.blueTeam;
  const orangeTeam = swapColors ? chosen.blueTeam : chosen.orangeTeam;

  return {
    blueTeam,
    orangeTeam,
    matchupKey: chosen.matchupKey,
  };
}

/**
 * Initializes a serpentine captains draft with specific captains.
 */
export function initializeCaptainsDraftWithCaptains(
  players: Player[],
  blueCaptainId: string,
  orangeCaptainId: string
) {
  const teamSize = teamSizeForRoster(players, 'Captains draft');

  const remaining = players
    .map(p => p.discord_id)
    .filter(id => id !== blueCaptainId && id !== orangeCaptainId);

  return {
    blueCaptain: blueCaptainId,
    orangeCaptain: orangeCaptainId,
    blueTeam: [blueCaptainId],
    orangeTeam: [orangeCaptainId],
    remainingPlayers: remaining,
    turn: 'BLUE' as const,
    pickNumber: 1,
    teamSize,
  };
}

/**
 * Initializes a serpentine captains draft.
 * Top 2 MMR players become Blue Captain and Orange Captain.
 */
export function initializeCaptainsDraft(players: Player[]) {
  teamSizeForRoster(players, 'Captains draft');

  const sorted = [...players].sort((a, b) => b.mmr - a.mmr);
  return initializeCaptainsDraftWithCaptains(players, sorted[0].discord_id, sorted[1].discord_id);
}

/**
 * Computes a unique canonical string key for a pair of captains.
 */
export function getCaptainPairKey(id1: string, id2: string): string {
  return [id1, id2].sort().join(',');
}

/**
 * Randomizes two distinct captains from the roster without repeating seen captain pairs.
 */
export function randomizeCaptains(
  players: Player[],
  currentBlue?: string,
  currentOrange?: string,
  seenPairs: string[] = []
): { blueCaptain: Player; orangeCaptain: Player; pairKey: string } {
  if (players.length < 2) {
    throw new Error('Need at least 2 players to choose captains.');
  }

  // Generate all 15 possible pairs
  const allPairs: { p1: Player; p2: Player; key: string }[] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      allPairs.push({
        p1: players[i],
        p2: players[j],
        key: getCaptainPairKey(players[i].discord_id, players[j].discord_id),
      });
    }
  }

  let available = allPairs.filter(p => !seenPairs.includes(p.key));
  if (available.length === 0) {
    available = allPairs;
  }

  const prevKey =
    currentBlue && currentOrange ? getCaptainPairKey(currentBlue, currentOrange) : undefined;
  if (prevKey && available.length > 1) {
    available = available.filter(p => p.key !== prevKey);
  }

  const chosen = available[Math.floor(Math.random() * available.length)];
  const swap = Math.random() > 0.5;

  return {
    blueCaptain: swap ? chosen.p2 : chosen.p1,
    orangeCaptain: swap ? chosen.p1 : chosen.p2,
    pairKey: chosen.key,
  };
}

export interface CaptainsDraftState {
  blueCaptain: string;
  orangeCaptain: string;
  blueTeam: string[];
  orangeTeam: string[];
  remainingPlayers: string[];
  turn: 'BLUE' | 'ORANGE';
  pickNumber: number;
  teamSize: number;
}

/** How many picks a draft of this size involves, excluding the auto-assigned last player. */
export function totalPicks(teamSize: number): number {
  return 2 * teamSize - 3;
}

/**
 * How many unique splits a roster of this size has: C(2n-1, n-1).
 * 3 at 2v2, 10 at 3v3, 35 at 4v4. Used for the "matchup 3/10 seen" counter.
 */
export function matchupCount(teamSize: number): number {
  let result = 1;
  for (let i = 0; i < teamSize - 1; i++) {
    result = (result * (2 * teamSize - 1 - i)) / (i + 1);
  }
  return Math.round(result);
}

/**
 * Validates and executes a pick in a captains draft.
 *
 * The turn order comes from getPickOrder rather than a hardcoded ladder, so 2v2, 3v3 and
 * 4v4 all work. Once one pick remains there is no choice left to make, so the final player
 * is auto-assigned to whichever team is short.
 */
export function processCaptainPick(
  draftState: CaptainsDraftState,
  pickerId: string,
  selectedPlayerId: string
): CaptainsDraftState {
  const teamSize = draftState.teamSize ?? (draftState.blueTeam.length +
    draftState.orangeTeam.length + draftState.remainingPlayers.length) / 2;

  // Check if it's the picker's turn
  const expectedCaptain =
    draftState.turn === 'BLUE' ? draftState.blueCaptain : draftState.orangeCaptain;
  if (pickerId !== expectedCaptain) {
    throw new Error('It is not your turn to pick a teammate!');
  }

  if (!draftState.remainingPlayers.includes(selectedPlayerId)) {
    throw new Error('Selected player is no longer available!');
  }

  // Remove selected from remaining
  draftState.remainingPlayers = draftState.remainingPlayers.filter(
    id => id !== selectedPlayerId
  );

  // Add to the picking team
  if (draftState.turn === 'BLUE') {
    draftState.blueTeam.push(selectedPlayerId);
  } else {
    draftState.orangeTeam.push(selectedPlayerId);
  }

  draftState.pickNumber += 1;

  const order = getPickOrder(teamSize);
  const nextTurn = order[draftState.pickNumber - 1];

  if (nextTurn) {
    draftState.turn = nextTurn;
  } else {
    // Every choice has been made -- the last player goes wherever there is a seat.
    const lastPlayerId = draftState.remainingPlayers[0];
    if (lastPlayerId) {
      if (draftState.blueTeam.length < teamSize) {
        draftState.blueTeam.push(lastPlayerId);
      } else {
        draftState.orangeTeam.push(lastPlayerId);
      }
      draftState.remainingPlayers = [];
    }
  }

  return draftState;
}
