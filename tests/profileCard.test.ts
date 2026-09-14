import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import {
  getOrCreatePlayer,
  setPlayerMmr,
  setPlayerDivision,
  updateDivision,
  createMatch,
  updateMatch,
  getDivisions,
  getPlayer,
} from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import { mmrBarFor, getBestTeammate, loadProfileCard } from '../src/services/profileCard';
import { divisionsHelp } from '../src/commands/help';

const G = 'guild_profile_test';

function player(id: string, division: string, mmr: number) {
  getOrCreatePlayer(G, 3, id, id);
  setPlayerDivision(G, 3, id, division);
  setPlayerMmr(G, 3, id, mmr);
  return getPlayer(G, 3, id)!;
}

/** A finished 3v3 with the given winner. */
function played(blue: string[], orange: string[], winner: 'BLUE' | 'ORANGE', teamSize = 3) {
  const m = createMatch({ guild_id: G, channel_id: 'q', team_size: teamSize, blue_team: blue, orange_team: orange });
  updateMatch(m.match_id, { state: 'COMPLETED', winner, completed_at: new Date().toISOString() });
}

beforeEach(() => {
  db.exec(
    `DELETE FROM matches WHERE guild_id = '${G}'; DELETE FROM player_ladders WHERE guild_id = '${G}';
     DELETE FROM players WHERE guild_id = '${G}'; DELETE FROM guild_divisions WHERE guild_id = '${G}';`
  );
  seedGuildDefaults(db, G);
});

describe('mmrBarFor', () => {
  it('ranked server: from the division start to its promotion line, named after the next rank', () => {
    updateDivision(G, 3, 'C', { queue_channel_id: 'c' });
    updateDivision(G, 3, 'B', { queue_channel_id: 'b' });
    const me = player('me', 'C', 1016);

    const bar = mmrBarFor(me, getDivisions(G, 3), me);

    // 1000 -> 1200, so 1016 is 8% along -- not the 85% the old 0-based bar showed.
    expect(bar).toMatchObject({ from: 1000, to: 1200, label: 'Promotes to Rank B at 1200' });
    expect(bar.progress).toBeCloseTo(0.08);
  });

  it('one-ladder server: never mentions a Rank B it does not have; measures to the leader', () => {
    updateDivision(G, 3, 'C', { queue_channel_id: 'c', display_name: '6mans' });
    const leader = player('leader', 'C', 1180);
    const me = player('me', 'C', 1090);

    const bar = mmrBarFor(me, getDivisions(G, 3), leader);

    expect(bar).toMatchObject({ from: 1000, to: 1180, label: 'Ladder top: 1180 (leader)' });
    expect(bar.progress).toBeCloseTo(0.5);
    expect(bar.label).not.toContain('Rank B');
  });

  it('the leader sees a full bar', () => {
    updateDivision(G, 3, 'C', { queue_channel_id: 'c' });
    const me = player('me', 'C', 1180);
    expect(mmrBarFor(me, getDivisions(G, 3), me)).toMatchObject({ progress: 1, label: "You're on top 👑" });
  });

  it('top division of a ranked server also measures to the leader', () => {
    updateDivision(G, 3, 'C', { queue_channel_id: 'c' });
    updateDivision(G, 3, 'A', { queue_channel_id: 'a' });
    const leader = player('leader', 'A', 1580);
    const me = player('me', 'A', 1540);

    const bar = mmrBarFor(me, getDivisions(G, 3), leader);

    expect(bar.label).toBe('Ladder top: 1580 (leader)');
    expect(bar.from).toBe(1500);
  });

  it('below the division start clamps to empty rather than going negative', () => {
    updateDivision(G, 3, 'C', { queue_channel_id: 'c' });
    updateDivision(G, 3, 'B', { queue_channel_id: 'b' });
    const me = player('me', 'C', 960);
    expect(mmrBarFor(me, getDivisions(G, 3), me).progress).toBe(0);
  });
});

describe('getBestTeammate', () => {
  it('is whoever you have won the most with, ties broken by games together', () => {
    for (const id of ['me', 'ally', 'other', 'x', 'y', 'z']) player(id, 'C', 1000);
    played(['me', 'ally', 'x'], ['other', 'y', 'z'], 'BLUE');
    played(['me', 'ally', 'x'], ['other', 'y', 'z'], 'BLUE');
    played(['me', 'other', 'x'], ['ally', 'y', 'z'], 'BLUE'); // one win with other and x
    played(['me', 'x', 'y'], ['ally', 'other', 'z'], 'ORANGE'); // a loss: x gets games but no win

    const best = getBestTeammate(G, 3, 'me')!;

    // ally: 2 wins / 2 games. x: 3 wins / 4 games. x has more wins.
    expect(best).toMatchObject({ discord_id: 'x', username: 'x', wins: 3, games: 4 });
  });

  it('breaks a wins tie by games played together', () => {
    for (const id of ['me', 'a', 'b', 'o1', 'o2', 'o3']) player(id, 'C', 1000);
    played(['me', 'a', 'b'], ['o1', 'o2', 'o3'], 'BLUE');
    played(['me', 'a', 'o1'], ['b', 'o2', 'o3'], 'ORANGE'); // a: 1 win / 2 games; b: 1 win / 1 game

    expect(getBestTeammate(G, 3, 'me')!.discord_id).toBe('a');
  });

  it('is undefined with no wins, and never a test bot', () => {
    for (const id of ['me', 'o1']) player(id, 'C', 1000);
    expect(getBestTeammate(G, 3, 'me')).toBeUndefined();

    played(['me', 'test_bot_1', 'test_bot_2'], ['o1', 'test_bot_3', 'test_bot_4'], 'BLUE');
    expect(getBestTeammate(G, 3, 'me')).toBeUndefined();
  });

  it('is per size: 2v2 and 3v3 can have different best teammates', () => {
    for (const id of ['me', 'three', 'two', 'o1', 'o2', 'o3']) player(id, 'C', 1000);
    played(['me', 'three', 'o3'], ['o1', 'o2', 'two'], 'BLUE', 3);
    played(['me', 'two'], ['o1', 'o2'], 'BLUE', 2);

    expect(getBestTeammate(G, 3, 'me')!.discord_id).toBe('three');
    expect(getBestTeammate(G, 2, 'me')!.discord_id).toBe('two');
  });
});

describe('loadProfileCard', () => {
  it('assembles rank, standing, bar and teammate for one ladder', () => {
    updateDivision(G, 3, 'C', { queue_channel_id: 'c' });
    const me = player('me', 'C', 1050);
    player('leader', 'C', 1100);
    player('mate', 'C', 1000);
    played(['me', 'mate', 'leader'], ['a', 'b', 'c'], 'BLUE');

    const card = loadProfileCard(G, 3, me);

    expect(card.rank).toBe(2);
    expect(card.totalPlayers).toBe(3);
    expect(card.bar.label).toBe('Ladder top: 1100 (leader)');
    expect(card.bestTeammate?.wins).toBe(1);
  });
});

describe('/help rank section', () => {
  it('one-ladder server: one line under the ladder name, no Rank B..S', () => {
    updateDivision(G, 3, 'C', { queue_channel_id: 'c', display_name: '6mans' });
    const section = divisionsHelp(G);
    expect(section.name).toBe('🏆 THE LADDER');
    expect(section.value).toContain('**6mans**');
    expect(section.value).not.toContain('Rank B');
  });

  it("ranked server: only the divisions set up, highest first, with the server's numbers", () => {
    updateDivision(G, 3, 'C', { queue_channel_id: 'c' });
    updateDivision(G, 3, 'B', { queue_channel_id: 'b', promote_at: 1450 });
    updateDivision(G, 3, 'A', { queue_channel_id: 'a' });
    const { value } = divisionsHelp(G);
    expect(value.indexOf('Rank A')).toBeLessThan(value.indexOf('Rank B'));
    expect(value.indexOf('Rank B')).toBeLessThan(value.indexOf('Rank C'));
    expect(value).toContain('**Rank B** — starts at 1300, promotes at 1450, relegates below 1200');
    expect(value).not.toContain('Rank X');
    expect(value).not.toContain('Rank S');
  });

  it('outside a guild falls back to a generic one-ladder line', () => {
    expect(divisionsHelp(null).name).toBe('🏆 THE LADDER');
  });
});
