import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import db from '../src/database/db';
import {
  Player,
  getPlayer,
  getOrCreatePlayer,
  getPlayersByIds,
  getLeaderboard,
  getPlayerRank,
  updatePlayerAfterMatch,
  setPlayerDivision,
  getDivisionByChannel,
  updateDivision,
  createMatch,
  getMatch,
} from '../src/database/queries';
import {
  runMigrations,
  seedGuildDefaults,
  SUPPORTED_TEAM_SIZES,
  DEFAULT_TEAM_SIZE,
} from '../src/database/migrations';
import {
  getAllUniqueMatchups,
  getPickOrder,
  totalPicks,
  matchupCount,
  createBalancedTeams,
  initializeCaptainsDraft,
  processCaptainPick,
  teamSizeForRoster,
} from '../src/services/draftService';
import { majorityOf, votesRequiredFor } from '../src/services/gameRules';

const G = 'guild_multiqueue_test';

function makePlayer(id: string, mmr: number, teamSize = DEFAULT_TEAM_SIZE): Player {
  return {
    guild_id: G,
    discord_id: id,
    username: `User_${id}`,
    team_size: teamSize,
    division: 'C',
    mmr,
    wins: 0,
    losses: 0,
    streak: 0,
    placed: 1,
    created_at: new Date().toISOString(),
  };
}

/** A roster of exactly `count` players with distinct MMRs. */
function roster(count: number): Player[] {
  return Array.from({ length: count }, (_, i) => makePlayer(`p${i + 1}`, 1000 + i * 50));
}

describe('unique matchup enumeration', () => {
  // C(2n-1, n-1): the lowest-id player is pinned to one side, which removes the
  // Blue/Orange mirror so each split is counted once.
  it.each([
    [2, 3],
    [3, 10],
    [4, 35],
  ])('%iv%i has %i unique splits', (teamSize, expected) => {
    expect(getAllUniqueMatchups(roster(teamSize * 2)).length).toBe(expected);
  });

  it('gives every split even teams and no repeated player', () => {
    for (const teamSize of SUPPORTED_TEAM_SIZES) {
      for (const m of getAllUniqueMatchups(roster(teamSize * 2))) {
        expect(m.blueTeam.length).toBe(teamSize);
        expect(m.orangeTeam.length).toBe(teamSize);
        const ids = [...m.blueTeam, ...m.orangeTeam].map(p => p.discord_id);
        expect(new Set(ids).size).toBe(teamSize * 2);
      }
    }
  });

  it('gives every split a distinct matchup key', () => {
    for (const teamSize of SUPPORTED_TEAM_SIZES) {
      const keys = getAllUniqueMatchups(roster(teamSize * 2)).map(m => m.matchupKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('rejects an odd or undersized roster rather than dropping a player', () => {
    expect(() => teamSizeForRoster(roster(4).slice(0, 3))).toThrow(/even roster/);
    expect(() => getAllUniqueMatchups(roster(4).slice(0, 2))).toThrow(/even roster/);
  });

  it.each(SUPPORTED_TEAM_SIZES)('picks a genuinely optimal split at %iv%i', teamSize => {
    // Spread MMRs so there is a single best answer worth finding, rather than a field of
    // ties that any split would satisfy.
    const players = Array.from({ length: teamSize * 2 }, (_, i) =>
      makePlayer(`p${i + 1}`, 900 + i * 137)
    );

    const gap = (team: Player[]) => team.reduce((s, p) => s + p.mmr, 0);
    const best = Math.min(
      ...getAllUniqueMatchups(players).map(m => Math.abs(gap(m.blueTeam) - gap(m.orangeTeam)))
    );

    const { blueTeam, orangeTeam } = createBalancedTeams(players);
    expect(Math.abs(gap(blueTeam) - gap(orangeTeam))).toBe(best);
  });
});

describe('captains draft pick order', () => {
  it('snakes, starting with Blue', () => {
    expect(getPickOrder(2)).toEqual(['BLUE']);
    expect(getPickOrder(3)).toEqual(['BLUE', 'ORANGE', 'ORANGE']);
    expect(getPickOrder(4)).toEqual(['BLUE', 'ORANGE', 'ORANGE', 'BLUE', 'BLUE']);
  });

  it('leaves exactly one player to be auto-assigned', () => {
    for (const teamSize of SUPPORTED_TEAM_SIZES) {
      // Two captains + the picks made + one auto-assigned = the whole roster.
      expect(2 + totalPicks(teamSize) + 1).toBe(teamSize * 2);
    }
  });

  it.each(SUPPORTED_TEAM_SIZES)('fills both teams at %iv%i', teamSize => {
    const players = roster(teamSize * 2);
    let draft = initializeCaptainsDraft(players);
    const order = getPickOrder(teamSize);

    for (const turn of order) {
      expect(draft.turn).toBe(turn);
      const picker = turn === 'BLUE' ? draft.blueCaptain : draft.orangeCaptain;
      draft = processCaptainPick(draft, picker, draft.remainingPlayers[0]);
    }

    expect(draft.remainingPlayers).toEqual([]);
    expect(draft.blueTeam.length).toBe(teamSize);
    expect(draft.orangeTeam.length).toBe(teamSize);

    const everyone = [...draft.blueTeam, ...draft.orangeTeam];
    expect(new Set(everyone).size).toBe(teamSize * 2);
  });

  it('rejects a pick from the captain whose turn it is not', () => {
    const draft = initializeCaptainsDraft(roster(6));
    expect(() =>
      processCaptainPick(draft, draft.orangeCaptain, draft.remainingPlayers[0])
    ).toThrow(/not your turn/);
  });
});

describe('matchupCount', () => {
  it('agrees with the actual enumeration', () => {
    for (const teamSize of SUPPORTED_TEAM_SIZES) {
      expect(matchupCount(teamSize)).toBe(getAllUniqueMatchups(roster(teamSize * 2)).length);
    }
  });

  it('returns whole numbers, not floats from the division', () => {
    for (const teamSize of SUPPORTED_TEAM_SIZES) {
      expect(Number.isInteger(matchupCount(teamSize))).toBe(true);
    }
  });
});

describe('vote thresholds', () => {
  it('needs a strict majority of the lobby', () => {
    expect(majorityOf(4)).toBe(3);
    expect(majorityOf(6)).toBe(4);
    expect(majorityOf(8)).toBe(5);
  });

  it('never asks for more votes than there are humans to give them', () => {
    // A 4v4 lobby with six bots in it can only ever produce two clicks.
    const lobby = ['human_1', 'human_2', ...Array.from({ length: 6 }, (_, i) => `test_bot_${i}`)];
    expect(votesRequiredFor(lobby)).toBe(2);
  });

  it('asks for the real majority in an all-human lobby', () => {
    expect(votesRequiredFor(Array.from({ length: 8 }, (_, i) => `h${i}`))).toBe(5);
    expect(votesRequiredFor(Array.from({ length: 4 }, (_, i) => `h${i}`))).toBe(3);
  });
});

describe('per-size ladders', () => {
  beforeEach(() => {
    db.exec(
      'DELETE FROM season_snapshots; DELETE FROM player_ladders; DELETE FROM players; ' +
        'DELETE FROM matches; DELETE FROM seasons; DELETE FROM guild_divisions; DELETE FROM guild_config;'
    );
    seedGuildDefaults(db, G);
  });

  it('starts a player fresh on each size rather than importing their other rating', () => {
    getOrCreatePlayer(G, 3, 'p1', 'Chris');
    updatePlayerAfterMatch(G, 3, 'p1', 250, true);
    expect(getPlayer(G, 3, 'p1')!.mmr).toBe(1250);

    const at2v2 = getOrCreatePlayer(G, 2, 'p1', 'Chris');
    expect(at2v2.mmr).toBe(1000);
    expect(at2v2.wins).toBe(0);
  });

  it('keeps a result on the ladder it was played on', () => {
    for (const size of SUPPORTED_TEAM_SIZES) getOrCreatePlayer(G, size, 'p1', 'Chris');

    updatePlayerAfterMatch(G, 4, 'p1', 30, true);

    expect(getPlayer(G, 4, 'p1')!.mmr).toBe(1030);
    expect(getPlayer(G, 4, 'p1')!.wins).toBe(1);
    // The other two ladders must be untouched.
    expect(getPlayer(G, 3, 'p1')!.mmr).toBe(1000);
    expect(getPlayer(G, 3, 'p1')!.wins).toBe(0);
    expect(getPlayer(G, 2, 'p1')!.mmr).toBe(1000);
  });

  it('places a player per size, not globally', () => {
    getOrCreatePlayer(G, 3, 'p1', 'Chris');
    getOrCreatePlayer(G, 2, 'p1', 'Chris');

    setPlayerDivision(G, 3, 'p1', 'A');

    expect(getPlayer(G, 3, 'p1')!.division).toBe('A');
    expect(getPlayer(G, 2, 'p1')!.division).toBe('C');
  });

  it('scopes the leaderboard and rank to one size', () => {
    getOrCreatePlayer(G, 3, 'strong', 'Strong');
    getOrCreatePlayer(G, 3, 'weak', 'Weak');
    getOrCreatePlayer(G, 2, 'weak', 'Weak');

    updatePlayerAfterMatch(G, 3, 'strong', 500, true);

    const board3 = getLeaderboard(G, 3, 'C');
    expect(board3.map(p => p.discord_id)).toEqual(['strong', 'weak']);

    // 'strong' has never played 2v2, so they are not on that board at all.
    const board2 = getLeaderboard(G, 2, 'C');
    expect(board2.map(p => p.discord_id)).toEqual(['weak']);
    expect(getPlayerRank(G, 2, 'weak')).toEqual({ rank: 1, total: 1, division: 'C' });
    expect(getPlayerRank(G, 2, 'strong')).toBeUndefined();
  });

  it('shares one username across every size, so a rename cannot go stale', () => {
    getOrCreatePlayer(G, 3, 'p1', 'OldName');
    getOrCreatePlayer(G, 2, 'p1', 'OldName');

    // They play 3v3 after renaming; the 2v2 row must pick it up too.
    getOrCreatePlayer(G, 3, 'p1', 'NewName');

    expect(getPlayer(G, 2, 'p1')!.username).toBe('NewName');
    expect(getPlayersByIds(G, 2, ['p1'])[0].username).toBe('NewName');
  });
});

describe('queue channels resolve to a ladder', () => {
  beforeEach(() => {
    db.exec(
      'DELETE FROM season_snapshots; DELETE FROM player_ladders; DELETE FROM players; ' +
        'DELETE FROM matches; DELETE FROM seasons; DELETE FROM guild_divisions; DELETE FROM guild_config;'
    );
    seedGuildDefaults(db, G);
  });

  it('maps a channel to exactly one (size, division)', () => {
    updateDivision(G, 4, 'A', { queue_channel_id: 'chan_4v4_a' });

    const found = getDivisionByChannel(G, 'chan_4v4_a')!;
    expect(found.team_size).toBe(4);
    expect(found.division).toBe('A');
  });

  it('releases a channel from its old ladder when another claims it', () => {
    updateDivision(G, 3, 'B', { queue_channel_id: 'chan_shared' });
    updateDivision(G, 2, 'C', { queue_channel_id: 'chan_shared' });

    // Two rows pointing at one channel would make getDivisionByChannel ambiguous.
    const rows = db
      .prepare('SELECT team_size, division FROM guild_divisions WHERE queue_channel_id = ?')
      .all('chan_shared') as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].team_size).toBe(2);

    expect(getDivisionByChannel(G, 'chan_shared')!.division).toBe('C');
  });

  it('stamps the match with the size it was played at', () => {
    const match = createMatch({
      guild_id: G,
      channel_id: 'chan_x',
      team_size: 4,
      blue_team: ['a', 'b', 'c', 'd'],
      orange_team: ['e', 'f', 'g', 'h'],
    });
    expect(getMatch(match.match_id)!.team_size).toBe(4);
  });
});

describe('migration 4 on a database that predates multi-queue', () => {
  let dbPath: string;
  let legacy: Database.Database;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `6mans_mq_${process.pid}_${Date.now()}_${Math.random()}.sqlite`
    );
    legacy = new Database(dbPath);
    legacy.pragma('foreign_keys = ON');
    runMigrations(legacy, { defaultGuildId: 'g_old' });
  });

  it('gives every supported size a division ladder', () => {
    for (const size of SUPPORTED_TEAM_SIZES) {
      const n = (
        legacy
          .prepare('SELECT COUNT(*) AS n FROM guild_divisions WHERE guild_id = ? AND team_size = ?')
          .get('g_old', size) as { n: number }
      ).n;
      expect(n, `${size}v${size} divisions`).toBe(5);
    }
  });

  it('leaves one season spanning all of them', () => {
    const seasons = legacy
      .prepare('SELECT * FROM seasons WHERE guild_id = ? AND is_active = 1')
      .all('g_old');
    expect(seasons.length).toBe(1);
  });

  afterEach(() => {
    legacy.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });
});
