import { Player } from '../database/queries';

export interface DraftResult {
  blueTeam: Player[];
  orangeTeam: Player[];
  matchupKey?: string;
}

/**
 * Computes a unique canonical string key for a 3v3 matchup of 6 players,
 * invariant to which team is Blue vs. Orange.
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
 * Returns all 10 unique 3v3 team combinations for 6 players.
 */
export function getAllUniqueMatchups(players: Player[]): DraftResult[] {
  if (players.length !== 6) {
    throw new Error('Requires exactly 6 players.');
  }

  const sorted = [...players].sort((a, b) => a.discord_id.localeCompare(b.discord_id));
  const refPlayer = sorted[0];
  const others = sorted.slice(1);

  const results: DraftResult[] = [];

  for (let i = 0; i < others.length; i++) {
    for (let j = i + 1; j < others.length; j++) {
      const teamA = [refPlayer, others[i], others[j]];
      const teamB = others.filter((_, idx) => idx !== i && idx !== j);
      const key = getMatchupKey(teamA, teamB);
      results.push({
        blueTeam: teamA,
        orangeTeam: teamB,
        matchupKey: key,
      });
    }
  }

  return results;
}

/**
 * Splits 6 players into two teams of 3 to minimize average MMR difference.
 */
export function createBalancedTeams(players: Player[]): DraftResult {
  if (players.length !== 6) {
    throw new Error('Balanced teams requires exactly 6 players.');
  }

  let bestBlue: Player[] = [];
  let bestOrange: Player[] = [];
  let minDiff = Infinity;

  // Generate all combinations of 3 players out of 6 (20 combinations)
  const indices = [0, 1, 2, 3, 4, 5];
  const totalMmr = players.reduce((sum, p) => sum + p.mmr, 0);

  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      for (let k = j + 1; k < 6; k++) {
        const blueIndices = [i, j, k];
        const blueSum = blueIndices.reduce((sum, idx) => sum + players[idx].mmr, 0);
        const orangeSum = totalMmr - blueSum;
        const diff = Math.abs(blueSum - orangeSum);

        if (diff < minDiff) {
          minDiff = diff;
          bestBlue = blueIndices.map(idx => players[idx]);
          bestOrange = indices
            .filter(idx => !blueIndices.includes(idx))
            .map(idx => players[idx]);
        }
      }
    }
  }

  const matchupKey = getMatchupKey(bestBlue, bestOrange);
  return { blueTeam: bestBlue, orangeTeam: bestOrange, matchupKey };
}

/**
 * Shuffles 6 players randomly into two teams of 3 without repeating any previously seen matchup
 * until all 10 possible unique matchups have been exhausted.
 */
export function createRandomTeams(players: Player[], seenMatchups: string[] = []): DraftResult {
  if (players.length !== 6) {
    throw new Error('Random teams requires exactly 6 players.');
  }

  const allMatchups = getAllUniqueMatchups(players);
  let available = allMatchups.filter(m => !seenMatchups.includes(m.matchupKey!));

  // If all 10 matchups have already been shown, reset the pool to all 10
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
 * Initializes a Captains 1-2-1 Draft state with specific captains.
 */
export function initializeCaptainsDraftWithCaptains(
  players: Player[],
  blueCaptainId: string,
  orangeCaptainId: string
) {
  if (players.length !== 6) {
    throw new Error('Captains draft requires exactly 6 players.');
  }

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
  };
}

/**
 * Initializes a Captains 1-2-1 Draft state.
 * Top 2 MMR players become Blue Captain and Orange Captain.
 */
export function initializeCaptainsDraft(players: Player[]) {
  if (players.length !== 6) {
    throw new Error('Captains draft requires exactly 6 players.');
  }

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
 * Randomizes two distinct captains from the 6 players without repeating seen captain pairs.
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

/**
 * Validates and executes a pick in Captains 1-2-1 Draft.
 */
export function processCaptainPick(
  draftState: {
    blueCaptain: string;
    orangeCaptain: string;
    blueTeam: string[];
    orangeTeam: string[];
    remainingPlayers: string[];
    turn: 'BLUE' | 'ORANGE';
    pickNumber: number;
  },
  pickerId: string,
  selectedPlayerId: string
) {
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

  // Determine next turn (1-2-1 draft order)
  // Pick 1: Blue -> next is Orange (Pick 2)
  // Pick 2: Orange -> next is Orange (Pick 3)
  // Pick 3: Orange -> next is Blue auto-pick (Pick 4)
  if (draftState.pickNumber === 2) {
    draftState.turn = 'ORANGE';
  } else if (draftState.pickNumber === 3) {
    draftState.turn = 'ORANGE';
  } else if (draftState.pickNumber === 4) {
    // Auto-assign the last player to Blue Team
    const lastPlayerId = draftState.remainingPlayers[0];
    if (lastPlayerId) {
      draftState.blueTeam.push(lastPlayerId);
      draftState.remainingPlayers = [];
    }
  }

  return draftState;
}
