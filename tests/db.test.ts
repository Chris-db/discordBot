import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import path from 'path';
import fs from 'fs';

// Set test db path before importing db modules
const testDbPath = path.join(process.cwd(), 'data', 'test_6mans.sqlite');
process.env.DB_PATH = testDbPath;

import db from '../src/database/db';
import { initializeDatabase } from '../src/database/schema';
import {
  getOrCreatePlayer,
  getPlayer,
  getLeaderboard,
  updatePlayerAfterMatch,
  getOrInitQueue,
  saveQueue,
  getQueue,
  createMatch,
  getMatch,
  updateMatch,
  getMatchGambleStatus,
  updateMatchGambleStatus,
  applyGambleResultToPlayer,
  getPlayerRank,
  isRlCredentialInUse,
  createBan,
  getActiveBan,
  revokeBan,
  getPlayerBanHistory,
  getActiveBansByGuild,
  getAverageMatchDuration,
} from '../src/database/queries';
import { getOrInitQueue as initQueueService, checkQueueTimeouts } from '../src/services/queueService';

describe('Database & Schema Tests', () => {
  beforeAll(() => {
    initializeDatabase();
  });

  beforeEach(() => {
    // Clear tables so every test starts with a clean slate
    db.exec('DELETE FROM players; DELETE FROM active_queues; DELETE FROM matches; DELETE FROM bans;');
  });

  it('creates and retrieves a player', () => {
    const p1 = getOrCreatePlayer('g1', 'discord_123', 'RocketPlayer');
    expect(p1.discord_id).toBe('discord_123');
    expect(p1.username).toBe('RocketPlayer');
    expect(p1.mmr).toBe(1000);

    const fetched = getPlayer('g1', 'discord_123');
    expect(fetched?.username).toBe('RocketPlayer');
  });

  it('updates player stats after a match', () => {
    getOrCreatePlayer('g1', 'discord_123', 'RocketPlayer');
    updatePlayerAfterMatch('g1', 'discord_123', 20, true);
    const p1 = getPlayer('g1', 'discord_123')!;
    expect(p1.mmr).toBe(1020);
    expect(p1.wins).toBe(1);
    expect(p1.streak).toBe(1);
  });

  it('orders leaderboard correctly', () => {
    getOrCreatePlayer('g1', 'discord_123', 'PlayerOne');
    getOrCreatePlayer('g1', 'discord_456', 'TopPlayer');
    updatePlayerAfterMatch('g1', 'discord_456', 500, true);

    const top = getLeaderboard('g1', undefined, 5);
    expect(top[0].discord_id).toBe('discord_456');
    expect(top[1].discord_id).toBe('discord_123');
  });

  it('saves and retrieves an active queue', () => {
    const q = initQueueService('channel_1', 'guild_1');
    q.player_ids = ['discord_123', 'discord_456'];
    saveQueue(q);

    const fetched = getQueue('channel_1');
    expect(fetched?.player_ids).toEqual(['discord_123', 'discord_456']);
  });

  it('creates and updates a match', () => {
    const m = createMatch({
      guild_id: 'guild_1',
      channel_id: 'channel_1',
      blue_team: ['discord_123'],
      orange_team: ['discord_456'],
      rl_name: 'RL6-1234',
      rl_pass: '9999',
    });

    expect(m.state).toBe('IN_PROGRESS');
    expect(m.rl_name).toBe('RL6-1234');

    const updated = updateMatch(m.match_id, { state: 'COMPLETED', winner: 'BLUE' });
    expect(updated.state).toBe('COMPLETED');
    expect(updated.winner).toBe('BLUE');
  });

  it('handles gamble_status and applyGambleResultToPlayer correctly', () => {
    const p = getOrCreatePlayer('g1', 'discord_gamble_1', 'GamblePlayer');
    expect(p.mmr).toBe(1000);

    // Apply +36 MMR from gamble
    const updatedP = applyGambleResultToPlayer('g1', 'discord_gamble_1', 36, 1, -1);
    expect(updatedP.mmr).toBe(1036);
    expect(updatedP.wins).toBe(1);

    const m = createMatch({
      guild_id: 'guild_1',
      channel_id: 'channel_1',
      blue_team: ['discord_gamble_1'],
      orange_team: ['discord_gamble_2'],
      rl_name: 'RL-GAMBLE',
      rl_pass: '1111',
    });

    const status = getMatchGambleStatus(m.match_id);
    expect(status.state).toBe('NONE');
    expect(status.agreedPlayers).toEqual([]);

    updateMatchGambleStatus(m.match_id, {
      state: 'PROPOSED',
      agreedPlayers: ['discord_gamble_1'],
    });

    const newStatus = getMatchGambleStatus(m.match_id);
    expect(newStatus.state).toBe('PROPOSED');
    expect(newStatus.agreedPlayers).toEqual(['discord_gamble_1']);
  });

  it('automatically removes players from the queue after 30 minutes of inactivity', async () => {
    const q = initQueueService('channel_timeout_1', 'guild_1');
    const oldTime = Date.now() - (31 * 60 * 1000); // 31 minutes ago
    const recentTime = Date.now() - (10 * 60 * 1000); // 10 minutes ago
    q.player_ids = ['player_old', 'player_recent'];
    q.player_join_times = {
      player_old: oldTime,
      player_recent: recentTime,
    };
    saveQueue(q);

    const mockClient = {
      channels: {
        fetch: async () => null,
      },
    } as any;

    await checkQueueTimeouts(mockClient);

    const after = getQueue('channel_timeout_1');
    expect(after?.player_ids).toEqual(['player_recent']);
    expect(after?.player_join_times).toEqual({ player_recent: recentTime });
  });

  it('does not remove players after 30 minutes if queue state is not WAITING', async () => {
    const q = initQueueService('channel_timeout_2', 'guild_1');
    const oldTime = Date.now() - (31 * 60 * 1000);
    q.state = 'READY_CHECK';
    q.player_ids = ['player_old'];
    q.player_join_times = {
      player_old: oldTime,
    };
    saveQueue(q);

    const mockClient = {
      channels: {
        fetch: async () => null,
      },
    } as any;

    await checkQueueTimeouts(mockClient);

    const after = getQueue('channel_timeout_2');
    expect(after?.player_ids).toEqual(['player_old']);
  });

  it('allows main queue to remain WAITING while a match queue is in READY_CHECK', () => {
    const mainQueue = initQueueService('channel_rank_a', 'guild_1');
    mainQueue.state = 'WAITING';
    mainQueue.player_ids = [];
    saveQueue(mainQueue);

    const matchQueue = initQueueService('channel_match_100', 'guild_1');
    matchQueue.state = 'READY_CHECK';
    matchQueue.player_ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    matchQueue.ready_check_vc_id = 'vc_ready_100';
    saveQueue(matchQueue);

    const fetchedMain = getQueue('channel_rank_a');
    const fetchedMatch = getQueue('channel_match_100');

    expect(fetchedMain?.state).toBe('WAITING');
    expect(fetchedMain?.player_ids).toEqual([]);
    expect(fetchedMatch?.state).toBe('READY_CHECK');
    expect(fetchedMatch?.ready_check_vc_id).toBe('vc_ready_100');
  });

  it('computes getPlayerRank correctly using SQL COUNT subquery', () => {
    getOrCreatePlayer('g1', 'p_mid', 'Mid');
    getOrCreatePlayer('g1', 'p_high', 'High');
    getOrCreatePlayer('g1', 'p_low', 'Low');

    updatePlayerAfterMatch('g1', 'p_high', 200, true);
    updatePlayerAfterMatch('g1', 'p_mid', 50, true);

    expect(getPlayerRank('g1', 'p_high')?.rank).toBe(1);
    expect(getPlayerRank('g1', 'p_mid')?.rank).toBe(2);
    expect(getPlayerRank('g1', 'p_low')?.rank).toBe(3);
    expect(getPlayerRank('g1', 'p_high')?.total).toBe(3);
  });

  it('isRlCredentialInUse only checks active matches and ignores historical matches', () => {
    // Create an active match using "swift-falcon-4"
    const activeMatch = createMatch({
      guild_id: 'guild_1',
      channel_id: 'chan_1',
      blue_team: ['a'],
      orange_team: ['b'],
      rl_name: 'swift-falcon-4',
      rl_pass: '123',
    });
    expect(isRlCredentialInUse('swift-falcon-4', '123')).toBe(true);

    // Complete the match
    updateMatch(activeMatch.match_id, { state: 'COMPLETED' });
    expect(isRlCredentialInUse('swift-falcon-4', '123')).toBe(false);
  });

  it('manages player queue bans and expiry correctly', () => {
    const guildId = 'test_guild_1';
    const p1 = 'user_ban_1';
    const p2 = 'user_ban_2';

    // Permanent ban
    const ban1 = createBan(guildId, p1, 'admin_1', 'Toxic behavior', null);
    expect(ban1.discord_id).toBe(p1);
    expect(ban1.revoked).toBe(0);
    expect(ban1.expires_at).toBeNull();

    const active1 = getActiveBan(guildId, p1);
    expect(active1).toBeDefined();
    expect(active1?.reason).toBe('Toxic behavior');

    // Revoke ban
    const revoked = revokeBan(guildId, p1);
    expect(revoked).toBe(true);
    expect(getActiveBan(guildId, p1)).toBeNull();

    // Expired ban (past date)
    const pastDate = new Date(Date.now() - 3600_000).toISOString();
    createBan(guildId, p2, 'admin_1', 'Short cooldown', pastDate);
    expect(getActiveBan(guildId, p2)).toBeNull(); // Should not be active since it expired

    // Active temporary ban (future date)
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    createBan(guildId, p2, 'admin_1', '1 hour ban', futureDate);
    expect(getActiveBan(guildId, p2)).toBeDefined();

    const history = getPlayerBanHistory(p2);
    expect(history.length).toBe(2);

    const activeGuildBans = getActiveBansByGuild(guildId);
    expect(activeGuildBans.length).toBe(1);
    expect(activeGuildBans[0].discord_id).toBe(p2);
  });

  it('tracks match started_at and computes average match duration', () => {
    const p1 = 'user_dur_1';
    const match1 = createMatch({
      guild_id: 'guild_1',
      channel_id: 'chan_1',
      state: 'DRAFTING',
      blue_team: [p1],
      orange_team: ['orange_1'],
    });
    expect(match1.started_at).toBeUndefined();

    // Set match IN_PROGRESS -> should record started_at
    const inProg = updateMatch(match1.match_id, { state: 'IN_PROGRESS' });
    expect(inProg.started_at).toBeDefined();
    expect(inProg.started_at).not.toBeNull();

    // Complete match 10 minutes later
    const startedTime = new Date(inProg.started_at!).getTime();
    const completedTime = new Date(startedTime + 600_000).toISOString(); // 10 mins (600 secs)
    updateMatch(match1.match_id, {
      state: 'COMPLETED',
      completed_at: completedTime,
    });

    const avgSecs = getAverageMatchDuration(p1);
    expect(avgSecs).toBe(600);
  });
});

