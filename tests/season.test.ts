import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import {
  getPlayer,
  getActiveSeason,
  getSeasonHistory,
  getSeasonSnapshots,
  getDivisions,
  setPlayerDivision,
  getLeaderboard,
  getPlayerRank,
  getOrCreatePlayer,
} from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import { endSeason, resolveDivisionChange, nextSeasonNameAfter } from '../src/services/seasonService';

const G = 'guild_season_test';

/** Identity plus one ladder row. Defaults to 3v3, the size everything used to be. */
function seedPlayerAt(
  guildId: string,
  teamSize: number,
  discordId: string,
  division: string,
  mmr: number,
  wins = 5,
  losses = 5
) {
  db.prepare(
    `INSERT OR REPLACE INTO players (guild_id, discord_id, username) VALUES (?, ?, ?)`
  ).run(guildId, discordId, `User_${discordId}`);
  db.prepare(
    `INSERT OR REPLACE INTO player_ladders
       (guild_id, discord_id, team_size, division, mmr, wins, losses, streak, placed)
     VALUES (?, ?, ?, ?, ?, ?, ?, 3, 1)`
  ).run(guildId, discordId, teamSize, division, mmr, wins, losses);
}

function seedPlayer(discordId: string, division: string, mmr: number, wins = 5, losses = 5) {
  seedPlayerAt(G, 3, discordId, division, mmr, wins, losses);
}

describe('season resets', () => {
  beforeEach(() => {
    // season_snapshots references seasons, so it has to go first.
    db.exec('DELETE FROM season_snapshots; DELETE FROM player_ladders; DELETE FROM players; DELETE FROM seasons; DELETE FROM guild_divisions; DELETE FROM guild_config;');
    seedGuildDefaults(db, G);
  });

  describe('resolveDivisionChange', () => {
    const ladder = () => getDivisions(G, 3);

    it('promotes a player who finished at or above the promotion line', () => {
      // Rank B promotes at 1400.
      expect(resolveDivisionChange({ division: 'B', mmr: 1400 }, ladder())).toEqual({
        toDivision: 'A',
        outcome: 'PROMOTED',
      });
    });

    it('relegates a player who finished below the relegation line', () => {
      // Rank B relegates below 1200.
      expect(resolveDivisionChange({ division: 'B', mmr: 1199 }, ladder())).toEqual({
        toDivision: 'C',
        outcome: 'RELEGATED',
      });
    });

    it('leaves a mid-table player where they are', () => {
      expect(resolveDivisionChange({ division: 'B', mmr: 1300 }, ladder())).toEqual({
        toDivision: 'B',
        outcome: 'STAYED',
      });
    });

    it('cannot promote out of the top division or relegate out of the bottom', () => {
      expect(resolveDivisionChange({ division: 'S', mmr: 5000 }, ladder()).outcome).toBe('STAYED');
      expect(resolveDivisionChange({ division: 'C', mmr: 0 }, ladder()).outcome).toBe('STAYED');
    });
  });

  describe('endSeason', () => {
    it('hard-resets everyone to their new division default', () => {
      seedPlayer('promoted', 'B', 1500); // above B's 1400 promotion line
      seedPlayer('stayed', 'B', 1300);
      seedPlayer('relegated', 'B', 1100); // below B's 1200 relegation line

      endSeason(G);

      // Divisions have their own defaults: C=1000, B=1300, A=1500.
      expect(getPlayer(G, 3, 'promoted')!.division).toBe('A');
      expect(getPlayer(G, 3, 'promoted')!.mmr).toBe(1500);
      expect(getPlayer(G, 3, 'stayed')!.division).toBe('B');
      expect(getPlayer(G, 3, 'stayed')!.mmr).toBe(1300);
      expect(getPlayer(G, 3, 'relegated')!.division).toBe('C');
      expect(getPlayer(G, 3, 'relegated')!.mmr).toBe(1000);
    });

    it('clears win/loss/streak so the new season starts even', () => {
      seedPlayer('p1', 'B', 1300, 40, 2);
      endSeason(G);

      const p = getPlayer(G, 3, 'p1')!;
      expect(p.wins).toBe(0);
      expect(p.losses).toBe(0);
      expect(p.streak).toBe(0);
    });

    it('snapshots final standings before wiping them', () => {
      seedPlayer('first', 'B', 1390, 30, 5);
      seedPlayer('second', 'B', 1310, 20, 10);
      seedPlayer('third', 'B', 1210, 10, 20);

      const { endedSeason } = endSeason(G);
      const snaps = getSeasonSnapshots(endedSeason.season_id, 3, 'B');

      expect(snaps.map(s => s.discord_id)).toEqual(['first', 'second', 'third']);
      expect(snaps.map(s => s.final_rank)).toEqual([1, 2, 3]);
      expect(snaps[0].final_mmr).toBe(1390);
      expect(snaps[0].final_wins).toBe(30);
      expect(snaps.every(s => s.outcome === 'STAYED')).toBe(true);
    });

    it('ranks within each division separately', () => {
      seedPlayer('a_top', 'A', 1450);
      seedPlayer('b_top', 'B', 1350);

      const { endedSeason } = endSeason(G);

      // Both are #1 -- of their own division, not of the server.
      expect(getSeasonSnapshots(endedSeason.season_id, 3, 'A')[0].final_rank).toBe(1);
      expect(getSeasonSnapshots(endedSeason.season_id, 3, 'B')[0].final_rank).toBe(1);
    });

    it('closes the old season and opens the next', () => {
      seedPlayer('p1', 'B', 1300);
      const before = getActiveSeason(G)!;
      expect(before.name).toBe('Season 1');

      const { endedSeason, newSeason } = endSeason(G);

      expect(endedSeason.season_id).toBe(before.season_id);
      expect(newSeason.name).toBe('Season 2');
      expect(getActiveSeason(G)!.season_id).toBe(newSeason.season_id);
      expect(getSeasonHistory(G).length).toBe(2);

      const closed = getSeasonHistory(G).find(s => s.season_id === endedSeason.season_id)!;
      expect(closed.is_active).toBe(0);
      expect(closed.ended_at).toBeTruthy();
    });

    it('does not touch another guild', () => {
      seedGuildDefaults(db, 'other_guild');
      seedPlayerAt('other_guild', 3, 'outsider', 'B', 1390, 12, 1);
      seedPlayer('insider', 'B', 1390);

      endSeason(G);

      const outsider = getPlayer('other_guild', 3, 'outsider')!;
      expect(outsider.mmr).toBe(1390);
      expect(outsider.wins).toBe(12);
      expect(getActiveSeason('other_guild')!.name).toBe('Season 1');
    });

    it('refuses when there is no active season', () => {
      db.exec(`DELETE FROM seasons WHERE guild_id = '${G}'`);
      expect(() => endSeason(G)).toThrow(/No active season/);
    });
  });

  describe('nextSeasonNameAfter', () => {
    it('increments a trailing number', () => {
      expect(nextSeasonNameAfter('Season 1')).toBe('Season 2');
      expect(nextSeasonNameAfter('Season 9')).toBe('Season 10');
    });

    it('falls back to a dated name for a non-numeric season', () => {
      expect(nextSeasonNameAfter('Summer Cup')).toMatch(/^Season \d{4}-\d{2}$/);
    });
  });
});

describe('guild-scoped players and divisions', () => {
  beforeEach(() => {
    // season_snapshots references seasons, so it has to go first.
    db.exec('DELETE FROM season_snapshots; DELETE FROM player_ladders; DELETE FROM players; DELETE FROM seasons; DELETE FROM guild_divisions; DELETE FROM guild_config;');
    seedGuildDefaults(db, G);
    seedGuildDefaults(db, 'guild_b');
  });

  it('keeps the same discord id independent across guilds', () => {
    getOrCreatePlayer(G, 3, 'shared', 'Shared');
    getOrCreatePlayer('guild_b', 3, 'shared', 'Shared');

    setPlayerDivision(G, 3, 'shared', 'A');

    expect(getPlayer(G, 3, 'shared')!.division).toBe('A');
    expect(getPlayer(G, 3, 'shared')!.mmr).toBe(1500);
    expect(getPlayer('guild_b', 3, 'shared')!.division).toBe('C');
    expect(getPlayer('guild_b', 3, 'shared')!.mmr).toBe(1000);
  });

  it('starts new players unplaced in the lowest division', () => {
    const p = getOrCreatePlayer(G, 3, 'rookie', 'Rookie');
    expect(p.division).toBe('C');
    expect(p.placed).toBe(0);
    expect(p.mmr).toBe(1000);
  });

  it('marks a player placed once an admin assigns a division', () => {
    getOrCreatePlayer(G, 3, 'rookie', 'Rookie');
    const placed = setPlayerDivision(G, 3, 'rookie', 'X')!;
    expect(placed.placed).toBe(1);
    expect(placed.division).toBe('X');
    expect(placed.mmr).toBe(1700);
  });

  it('can move a player without resetting their MMR', () => {
    getOrCreatePlayer(G, 3, 'keep', 'Keep');
    setPlayerDivision(G, 3, 'keep', 'B', false);
    expect(getPlayer(G, 3, 'keep')!.division).toBe('B');
    expect(getPlayer(G, 3, 'keep')!.mmr).toBe(1000);
  });

  it('rejects a division the guild does not have', () => {
    getOrCreatePlayer(G, 3, 'p1', 'P1');
    expect(() => setPlayerDivision(G, 3, 'p1', 'Z')).toThrow(/not configured/);
  });

  it('scopes leaderboards and ranks to one division', () => {
    seedPlayerAt(G, 3, 'a1', 'A', 1600, 0, 0);
    seedPlayerAt(G, 3, 'a2', 'A', 1500, 0, 0);
    seedPlayerAt(G, 3, 'b1', 'B', 1390, 0, 0);

    const aBoard = getLeaderboard(G, 3, 'A');
    expect(aBoard.map(p => p.discord_id)).toEqual(['a1', 'a2']);

    // b1 has the lowest MMR overall but tops their own division.
    expect(getPlayerRank(G, 3, 'b1')).toEqual({ rank: 1, total: 1, division: 'B' });
    expect(getPlayerRank(G, 3, 'a2')).toEqual({ rank: 2, total: 2, division: 'A' });
  });
});
