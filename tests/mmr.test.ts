import { describe, it, expect } from 'vitest';
import { calculateMmrDelta, getRankTier } from '../src/services/mmrService';
import { Player } from '../src/database/queries';

const makePlayer = (id: string, mmr: number): Player => ({
  discord_id: id,
  username: `Player_${id}`,
  mmr,
  wins: 10,
  losses: 5,
  streak: 2,
  created_at: new Date().toISOString(),
});

describe('MMR Service', () => {
  it('correctly calculates ELO delta for even teams', () => {
    const blueTeam = [makePlayer('1', 1000), makePlayer('2', 1000), makePlayer('3', 1000)];
    const orangeTeam = [makePlayer('4', 1000), makePlayer('5', 1000), makePlayer('6', 1000)];

    const resBlueWin = calculateMmrDelta(blueTeam, orangeTeam, 'BLUE');
    expect(resBlueWin.blueDelta).toBe(16);
    expect(resBlueWin.orangeDelta).toBe(-16);
    expect(resBlueWin.blueAvgMmr).toBe(1000);
    expect(resBlueWin.orangeAvgMmr).toBe(1000);
  });

  it('rewards underdog wins more than favorite wins', () => {
    const underdogTeam = [makePlayer('1', 900), makePlayer('2', 900), makePlayer('3', 900)];
    const favoriteTeam = [makePlayer('4', 1200), makePlayer('5', 1200), makePlayer('6', 1200)];

    const resUnderdogWin = calculateMmrDelta(underdogTeam, favoriteTeam, 'BLUE');
    expect(resUnderdogWin.blueDelta).toBeGreaterThan(20);
    expect(resUnderdogWin.orangeDelta).toBeLessThan(-20);
  });

  it('assigns correct rank tiers and emojis', () => {
    expect(getRankTier(1850).name).toBe('Rank S');
    expect(getRankTier(1650).name).toBe('Rank X');
    expect(getRankTier(1450).name).toBe('Rank A');
    expect(getRankTier(1250).name).toBe('Rank B');
    expect(getRankTier(1050).name).toBe('Rank C');
  });
});
