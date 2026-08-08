import { Player, getDivision } from '../database/queries';

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

export interface RankTier {
  name: string;
  emoji: string;
  color: string;
}

/**
 * Presentation for each rank division.
 *
 * Colours are chosen to stay distinguishable for red-green colour blindness, which the
 * previous palette did not -- it put red at Rank X next to purple at Rank A, a pairing
 * roughly 8% of men cannot separate at emoji size. Ordering is now conveyed by the
 * badge letter as well as the colour.
 */
const DIVISION_TIERS: Record<string, RankTier> = {
  C: { name: 'Rank C', emoji: '🟢', color: '#00e676' }, // Green  (Diamond / Champ 1)
  B: { name: 'Rank B', emoji: '🔵', color: '#2979ff' }, // Blue   (Champ 2 / Champ 3)
  A: { name: 'Rank A', emoji: '🟣', color: '#aa00ff' }, // Purple (GC1 / GC2)
  X: { name: 'Rank X', emoji: '⚔️', color: '#ff8f00' }, // Amber  (GC3 / Low SSL)
  S: { name: 'Rank S', emoji: '👑', color: '#ffd700' }, // Gold   (SSL / Pro)
};

/**
 * Returns the badge for a stored rank division.
 *
 * Rank is stored state now, not a function of MMR: a player stays in their division for
 * the whole season and only moves at a season reset via promotion or relegation. Deriving
 * the badge from MMR would contradict the division they are actually queuing in.
 */
export function getDivisionTier(division: string): RankTier {
  return DIVISION_TIERS[division] || DIVISION_TIERS.C;
}

/**
 * Whether a player currently sits above their division's promotion line or below its
 * relegation line, for the badge on result and gamble cards.
 *
 * The cards used to compare the MMR band before and after the match and declare
 * "PROMOTED TO RANK B!" on the spot. That is no longer true: divisions only change at a
 * season reset, so crossing 1200 mid-season promotes nobody. This reports standing
 * against the line instead, which keeps the moment without lying about it.
 */
export function getPromotionStatus(
  guildId: string,
  division: string,
  mmr: number
): { label: string; color: string } | null {
  const config = getDivision(guildId, division);
  if (!config) return null;

  if (config.promote_at !== null && mmr >= config.promote_at) {
    return { label: '↑ PROMOTION ZONE', color: '#ffd700' };
  }
  if (config.relegate_below !== null && mmr < config.relegate_below) {
    return { label: '↓ RELEGATION ZONE', color: '#ff5252' };
  }
  return null;
}
