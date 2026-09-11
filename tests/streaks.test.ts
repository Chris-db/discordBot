import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import { getStreakBadge, getStreakChip, getPromotionStatus } from '../src/services/mmrService';
import { getOrCreatePlayer, getPlayer, updatePlayerAfterMatch } from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';

const G = 'guild_streak_test';

describe('streak badges', () => {
  it('stays quiet below three wins', () => {
    expect(getStreakBadge(0)).toBeNull();
    expect(getStreakBadge(1)).toBeNull();
    expect(getStreakBadge(2)).toBeNull();
  });

  it('carries an emoji for anywhere with room to draw it', () => {
    expect(getStreakBadge(4)!.full).toBe('🔥 4 WIN STREAK');
    expect(getStreakBadge(6)!.full).toBe('🔥🔥 6 WIN STREAK');
    expect(getStreakBadge(11)!.full).toBe('💀 11 WIN STREAK');
  });

  it('gets louder as the run gets longer', () => {
    expect(getStreakBadge(3)!.label).toBe('3 WIN STREAK');
    expect(getStreakBadge(4)!.label).toBe('4 WIN STREAK');
    expect(getStreakBadge(5)!.label).toBe('5 WIN STREAK');
    expect(getStreakBadge(9)!.label).toBe('9 WIN STREAK');
    expect(getStreakBadge(10)!.label).toBe('10 WIN STREAK');
  });

  it('never calls out a losing run', () => {
    // streak is negative for losses. Six people are looking at this card.
    expect(getStreakBadge(-1)).toBeNull();
    expect(getStreakBadge(-3)).toBeNull();
    expect(getStreakBadge(-10)).toBeNull();
  });

  it('has a compact form for the queue panel', () => {
    expect(getStreakChip(2)).toBeNull();
    expect(getStreakChip(3)).toBe('🔥 3');
    expect(getStreakChip(12)).toBe('🔥 12');
    expect(getStreakChip(-4)).toBeNull();
  });
});

describe('streak values the cards actually render', () => {
  beforeEach(() => {
    db.exec('DELETE FROM season_snapshots; DELETE FROM player_ladders; DELETE FROM players; DELETE FROM seasons; DELETE FROM guild_divisions; DELETE FROM guild_config;');
    seedGuildDefaults(db, G);
  });

  it('reads the streak the win just produced, not the one before it', () => {
    getOrCreatePlayer(G, 3, 'p1', 'P1');

    // The result card was previously handed the pre-match row, so a third straight win
    // would have rendered as a 2 streak -- or nothing at all.
    for (let i = 0; i < 3; i++) {
      updatePlayerAfterMatch(G, 3, 'p1', 10, true);
    }

    const after = getPlayer(G, 3, 'p1')!;
    expect(after.streak).toBe(3);
    expect(getStreakBadge(after.streak)!.label).toBe('3 WIN STREAK');
  });

  it('resets the badge when a run is broken', () => {
    getOrCreatePlayer(G, 3, 'p1', 'P1');
    for (let i = 0; i < 4; i++) updatePlayerAfterMatch(G, 3, 'p1', 10, true);
    expect(getStreakBadge(getPlayer(G, 3, 'p1')!.streak)).not.toBeNull();

    updatePlayerAfterMatch(G, 3, 'p1', -10, false);
    expect(getPlayer(G, 3, 'p1')!.streak).toBe(-1);
    expect(getStreakBadge(getPlayer(G, 3, 'p1')!.streak)).toBeNull();
  });
});

describe('promotion zone transitions', () => {
  beforeEach(() => {
    db.exec('DELETE FROM season_snapshots; DELETE FROM player_ladders; DELETE FROM players; DELETE FROM seasons; DELETE FROM guild_divisions; DELETE FROM guild_config;');
    seedGuildDefaults(db, G);
  });

  // Rank B: promotes at 1400, relegates below 1200.

  it('calls out the match that crossed the promotion line', () => {
    expect(getPromotionStatus(G, 3, 'B', 1405, 1390)!.label).toBe('ENTERED PROMO ZONE');
  });

  it('reports a steady state for someone already above the line', () => {
    expect(getPromotionStatus(G, 3, 'B', 1450, 1420)!.label).toBe('PROMOTION ZONE');
  });

  it('calls out dropping into the relegation zone', () => {
    expect(getPromotionStatus(G, 3, 'B', 1190, 1210)!.label).toBe('ENTERED DROP ZONE');
  });

  it('reports a steady state for someone already below the line', () => {
    expect(getPromotionStatus(G, 3, 'B', 1150, 1180)!.label).toBe('RELEGATION ZONE');
  });

  it('says nothing in the middle of the division', () => {
    expect(getPromotionStatus(G, 3, 'B', 1300, 1290)).toBeNull();
  });

  it('falls back to the steady-state label when there is no previous MMR', () => {
    expect(getPromotionStatus(G, 3, 'B', 1450)!.label).toBe('PROMOTION ZONE');
  });

  it('never promotes out of the top division or relegates out of the bottom', () => {
    // Rank S has no promote_at, Rank C has no relegate_below.
    expect(getPromotionStatus(G, 3, 'S', 5000, 4000)).toBeNull();
    expect(getPromotionStatus(G, 3, 'C', 0, 100)).toBeNull();
  });

  it('returns nothing for a division the guild does not have', () => {
    expect(getPromotionStatus(G, 3, 'Z', 1500, 1400)).toBeNull();
  });
});

describe('zone arrow direction', () => {
  beforeEach(() => seedGuildDefaults(db, G));
  it('points up in the promotion zone and down in the relegation zone', () => {
    expect(getPromotionStatus(G, 3, 'B', 1405, 1390)!.direction).toBe('up');
    expect(getPromotionStatus(G, 3, 'B', 1450, 1420)!.direction).toBe('up');
    expect(getPromotionStatus(G, 3, 'B', 1190, 1210)!.direction).toBe('down');
    expect(getPromotionStatus(G, 3, 'B', 1150, 1180)!.direction).toBe('down');
  });
});
