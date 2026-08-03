import { Player } from '../database/queries';

export interface MmrCalculationResult {
  blueDelta: number;
  orangeDelta: number;
  blueAvgMmr: number;
  orangeAvgMmr: number;
}

/**
 * Calculates ELO rating adjustments based on team average MMR and the winner.
 * K-factor is set to 32 by default, with a floor of +/- 10 and cap of +/- 45.
 */
export function calculateMmrDelta(
  blueTeam: Player[],
  orangeTeam: Player[],
  winner: 'BLUE' | 'ORANGE'
): MmrCalculationResult {
  const blueAvgMmr =
    blueTeam.reduce((sum, p) => sum + p.mmr, 0) / (blueTeam.length || 1);
  const orangeAvgMmr =
    orangeTeam.reduce((sum, p) => sum + p.mmr, 0) / (orangeTeam.length || 1);

  const expectedBlue = 1 / (1 + Math.pow(10, (orangeAvgMmr - blueAvgMmr) / 400));
  const expectedOrange = 1 / (1 + Math.pow(10, (blueAvgMmr - orangeAvgMmr) / 400));

  const K = 32;

  const actualBlue = winner === 'BLUE' ? 1 : 0;
  const actualOrange = winner === 'ORANGE' ? 1 : 0;

  let blueDelta = Math.round(K * (actualBlue - expectedBlue));
  let orangeDelta = Math.round(K * (actualOrange - expectedOrange));

  // Ensure minimum meaningful reward/penalty
  if (winner === 'BLUE') {
    blueDelta = Math.max(12, Math.min(45, blueDelta));
    orangeDelta = Math.min(-12, Math.max(-45, orangeDelta));
  } else {
    orangeDelta = Math.max(12, Math.min(45, orangeDelta));
    blueDelta = Math.min(-12, Math.max(-45, blueDelta));
  }

  return {
    blueDelta,
    orangeDelta,
    blueAvgMmr: Math.round(blueAvgMmr),
    orangeAvgMmr: Math.round(orangeAvgMmr),
  };
}

/**
 * Returns a rank tier title, Discord emoji badge, and color hex based on MMR.
 * Competitive 6mans progression: Rank C -> B -> A -> X -> S
 */
export function getRankTier(mmr: number): { name: string; emoji: string; color: string } {
  if (mmr >= 1800) {
    return { name: 'Rank S', emoji: '👑', color: '#ffd700' }; // Gold (SSL / Pro)
  } else if (mmr >= 1600) {
    return { name: 'Rank X', emoji: '⚔️', color: '#ff1744' }; // Crimson (GC3 / Low SSL)
  } else if (mmr >= 1400) {
    return { name: 'Rank A', emoji: '🟣', color: '#aa00ff' }; // Purple (GC1 / GC2)
  } else if (mmr >= 1200) {
    return { name: 'Rank B', emoji: '🔵', color: '#2979ff' }; // Blue (Champ 2 / Champ 3)
  } else {
    return { name: 'Rank C', emoji: '🟢', color: '#00e676' }; // Green (< 1200 MMR: Diamond / Champ 1)
  }
}
