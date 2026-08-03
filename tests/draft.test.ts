import { describe, it, expect } from 'vitest';
import {
  createBalancedTeams,
  createRandomTeams,
  getAllUniqueMatchups,
  initializeCaptainsDraft,
  processCaptainPick,
  randomizeCaptains,
} from '../src/services/draftService';
import { generateRlCredentials } from '../src/utils/rlCredentials';
import { Player } from '../src/database/queries';

const makePlayer = (id: string, mmr: number): Player => ({
  discord_id: id,
  username: `Player_${id}`,
  mmr,
  wins: 0,
  losses: 0,
  streak: 0,
  created_at: new Date().toISOString(),
});

describe('Draft Service', () => {
  it('splits 6 players into balanced teams minimizing MMR difference', () => {
    const players = [
      makePlayer('p1', 1500),
      makePlayer('p2', 1300),
      makePlayer('p3', 1100),
      makePlayer('p4', 1050),
      makePlayer('p5', 950),
      makePlayer('p6', 900),
    ];

    const { blueTeam, orangeTeam } = createBalancedTeams(players);
    expect(blueTeam.length).toBe(3);
    expect(orangeTeam.length).toBe(3);

    const blueSum = blueTeam.reduce((acc, p) => acc + p.mmr, 0);
    const orangeSum = orangeTeam.reduce((acc, p) => acc + p.mmr, 0);
    const diff = Math.abs(blueSum - orangeSum);

    // Should find optimal partition where difference is small (here 1500+1050+900 = 3450 vs 1300+1100+950 = 3350 -> diff = 100)
    expect(diff).toBeLessThanOrEqual(100);
  });

  it('shuffles 6 players into two teams of 3 randomly', () => {
    const players = [1, 2, 3, 4, 5, 6].map(n => makePlayer(String(n), 1000));
    const { blueTeam, orangeTeam } = createRandomTeams(players);
    expect(blueTeam.length).toBe(3);
    expect(orangeTeam.length).toBe(3);
  });

  it('executes a Captains 1-2-1 draft correctly', () => {
    const players = [
      makePlayer('c_blue', 1500),
      makePlayer('c_orange', 1400),
      makePlayer('p3', 1200),
      makePlayer('p4', 1100),
      makePlayer('p5', 1000),
      makePlayer('p6', 900),
    ];

    let draft = initializeCaptainsDraft(players);
    expect(draft.blueCaptain).toBe('c_blue');
    expect(draft.orangeCaptain).toBe('c_orange');
    expect(draft.turn).toBe('BLUE');
    expect(draft.remainingPlayers.length).toBe(4);

    // Pick 1: Blue Captain picks p3
    draft = processCaptainPick(draft, 'c_blue', 'p3');
    expect(draft.blueTeam).toContain('p3');
    expect(draft.turn).toBe('ORANGE');

    // Pick 2: Orange Captain picks p4
    draft = processCaptainPick(draft, 'c_orange', 'p4');
    expect(draft.orangeTeam).toContain('p4');
    expect(draft.turn).toBe('ORANGE'); // 1-2-1 means Orange gets back-to-back picks!

    // Pick 3: Orange Captain picks p5 (last player p6 auto-assigned to Blue)
    draft = processCaptainPick(draft, 'c_orange', 'p5');
    expect(draft.orangeTeam).toContain('p5');
    expect(draft.blueTeam).toContain('p6'); // auto assigned
    expect(draft.remainingPlayers.length).toBe(0);
    expect(draft.blueTeam.length).toBe(3);
    expect(draft.orangeTeam.length).toBe(3);
  });

  it('randomizes new captains distinct from previous captains', () => {
    const players = [
      makePlayer('c_blue', 1500),
      makePlayer('c_orange', 1400),
      makePlayer('p3', 1200),
      makePlayer('p4', 1100),
      makePlayer('p5', 1000),
      makePlayer('p6', 900),
    ];
    const { blueCaptain, orangeCaptain } = randomizeCaptains(players, 'c_blue', 'c_orange');
    expect(blueCaptain.discord_id).not.toBe(orangeCaptain.discord_id);
    const samePair = blueCaptain.discord_id === 'c_blue' && orangeCaptain.discord_id === 'c_orange';
    expect(samePair).toBe(false);
  });

  it('generates shorter unique RLxx lobby names and 3-digit passwords', () => {
    const { rlName, rlPass } = generateRlCredentials();
    expect(rlName).toMatch(/^RL\d{2,3}$/);
    expect(rlPass).toMatch(/^\d{3}$/);
  });

  it('computes exactly 10 unique color-invariant matchups for 6 players', () => {
    const players = [1, 2, 3, 4, 5, 6].map(n => makePlayer(String(n), 1000));
    const allMatchups = getAllUniqueMatchups(players);
    expect(allMatchups.length).toBe(10);

    const keys = new Set(allMatchups.map(m => m.matchupKey));
    expect(keys.size).toBe(10);
  });

  it('shuffles 6 players into teams without repeating any seen matchup until all 10 are exhausted', () => {
    const players = [1, 2, 3, 4, 5, 6].map(n => makePlayer(String(n), 1000));
    const seenMatchups: string[] = [];

    // Generate 10 consecutive matchups and verify all 10 are distinct
    for (let i = 0; i < 10; i++) {
      const { blueTeam, orangeTeam, matchupKey } = createRandomTeams(players, seenMatchups);
      expect(blueTeam.length).toBe(3);
      expect(orangeTeam.length).toBe(3);
      expect(matchupKey).toBeDefined();
      expect(seenMatchups).not.toContain(matchupKey!);
      seenMatchups.push(matchupKey!);
    }

    expect(seenMatchups.length).toBe(10);
    const uniqueCount = new Set(seenMatchups).size;
    expect(uniqueCount).toBe(10);

    // 11th call should reset the available pool and produce a valid matchup
    const res11 = createRandomTeams(players, seenMatchups);
    expect(res11.blueTeam.length).toBe(3);
    expect(res11.orangeTeam.length).toBe(3);
    expect(res11.matchupKey).toBeDefined();
  });

  it('randomizes captains without repeating seen pairs until all 15 are exhausted', () => {
    const players = [1, 2, 3, 4, 5, 6].map(n => makePlayer(String(n), 1000));
    const seenPairs: string[] = [];

    for (let i = 0; i < 15; i++) {
      const { blueCaptain, orangeCaptain, pairKey } = randomizeCaptains(players, undefined, undefined, seenPairs);
      expect(blueCaptain.discord_id).not.toBe(orangeCaptain.discord_id);
      expect(seenPairs).not.toContain(pairKey);
      seenPairs.push(pairKey);
    }

    expect(new Set(seenPairs).size).toBe(15);
  });
});


