import { describe, it, expect } from 'vitest';
import { calculateMmrDelta, getDivisionTier } from '../src/services/mmrService';
import { Player } from '../src/database/queries';

const makePlayer = (id: string, mmr: number): Player => ({
  guild_id: 'g1',
  discord_id: id,
  username: `Player_${id}`,
  division: 'C',
  mmr,
  wins: 10,
  losses: 5,
  streak: 2,
  placed: 1,
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

  it('badges a player by their stored division, not their MMR', () => {
    // Rank is stored state now. A player sitting on 1850 MMR in Rank C is still Rank C
    // until a season reset promotes them -- deriving the badge from MMR would show a
    // rank they are not actually queuing in.
    expect(getDivisionTier('S').name).toBe('Rank S');
    expect(getDivisionTier('X').name).toBe('Rank X');
    expect(getDivisionTier('A').name).toBe('Rank A');
    expect(getDivisionTier('B').name).toBe('Rank B');
    expect(getDivisionTier('C').name).toBe('Rank C');
  });

  it('falls back to the lowest division for an unknown code', () => {
    expect(getDivisionTier('').name).toBe('Rank C');
    expect(getDivisionTier('nonsense').name).toBe('Rank C');
  });
});
