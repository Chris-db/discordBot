import db from './db';
import config from '../config';

export interface Player {
  guild_id: string;
  discord_id: string;
  username: string;
  /** Stored rank division (C|B|A|X|S), not derived from mmr. */
  division: string;
  mmr: number;
  wins: number;
  losses: number;
  streak: number;
  /** 0 until an admin has placed them; grandfathered players migrated in as placed. */
  placed: number;
  created_at: string;
}

export interface GuildDivision {
  guild_id: string;
  division: string;
  display_name: string;
  default_mmr: number;
  promote_at: number | null;
  relegate_below: number | null;
  queue_channel_id?: string;
  role_id?: string;
  sort_order: number;
}

export interface Season {
  season_id: number;
  guild_id: string;
  name: string;
  started_at: string;
  ended_at?: string;
  is_active: number;
}

export interface SeasonSnapshot {
  id: number;
  season_id: number;
  guild_id: string;
  discord_id: string;
  division: string;
  final_mmr: number;
  final_wins: number;
  final_losses: number;
  final_rank: number;
  outcome: 'PROMOTED' | 'RELEGATED' | 'STAYED';
}

export interface ActiveQueue {
  channel_id: string;
  guild_id: string;
  message_id?: string;
  player_ids: string[];
  player_join_times?: Record<string, number>;
  state: 'WAITING' | 'READY_CHECK' | 'VOTING' | 'CAPTAINS_VOTE' | 'TEAMS_VOTE' | 'DRAFTING' | 'IN_MATCH';
  ready_check_vc_id?: string;
  vote_counts: Record<string, string[]>; // mode -> array of discord_ids who voted
  draft_state?: {
    blueCaptain: string;
    orangeCaptain: string;
    blueTeam: string[];
    orangeTeam: string[];
    remainingPlayers: string[];
    turn: 'BLUE' | 'ORANGE';
    pickNumber: number; // 1 to 4
  };
  captain_vote_state?: {
    blueCaptain: string;
    orangeCaptain: string;
    yesVotes: string[];
    noVotes: string[];
    seenCaptainPairs?: string[];
    message_id?: string;
  };
  team_vote_state?: {
    blueTeam: string[];
    orangeTeam: string[];
    yesVotes: string[];
    noVotes: string[];
    seenMatchups?: string[];
    // The mode the queue actually voted for. Without this a re-roll has no way to know
    // whether to generate another balanced split or a random one.
    mode?: 'random' | 'balanced';
    message_id?: string;
  };
}

export interface Match {
  match_id: number;
  guild_id: string;
  channel_id: string;
  state: 'READY_CHECK' | 'VOTING' | 'CAPTAINS_VOTE' | 'DRAFTING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  blue_team: string[];
  orange_team: string[];
  rl_name: string;
  rl_pass: string;
  blue_voice_id?: string;
  orange_voice_id?: string;
  /** Temporary "Ready Check #N" VC. Owned by the match so cleanup can always find it. */
  ready_check_vc_id?: string;
  message_id?: string;
  text_channel_id?: string;
  queue_channel_id?: string;
  feed_channel_id?: string;
  feed_message_id?: string;
  winner: 'BLUE' | 'ORANGE' | 'NONE';
  report_status: {
    blueVotes?: string[];
    orangeVotes?: string[];
    cancelVotes?: string[];
    rerollVotes?: string[];
    seenMatchups?: string[];
  };
  gamble_status?: GambleStatus;
  created_at: string;
  completed_at?: string;
  started_at?: string;
}

export interface Ban {
  id: number;
  guild_id: string;
  discord_id: string;
  banned_by: string;
  reason: string;
  created_at: string;
  expires_at: string | null;
  revoked: number;
}

export interface GambleStatus {
  state: 'NONE' | 'PROPOSED' | 'SPINNING' | 'RESOLVED' | 'DECLINED' | 'EXPIRED';
  proposedAt?: number;
  proposedBy?: string;
  agreedPlayers: string[];
  declinedBy?: string;
  wheelWinner?: 'BLUE' | 'ORANGE';
  resultType?: 'INVERTED' | 'DOUBLED';
  blueDelta?: number;
  orangeDelta?: number;
}

// ==================== Player Queries ====================

/**
 * Every player query is scoped by guild.
 *
 * `discord_id` used to be the primary key on its own, so a second server would have shared
 * one MMR pool and one leaderboard with the first. The key is now (guild_id, discord_id),
 * which means a bare discord id no longer identifies a row and callers have to say which
 * server they mean.
 */
export function getPlayer(guildId: string, discordId: string): Player | undefined {
  const stmt = db.prepare('SELECT * FROM players WHERE guild_id = ? AND discord_id = ?');
  return stmt.get(guildId, discordId) as Player | undefined;
}

export function getOrCreatePlayer(guildId: string, discordId: string, username: string): Player {
  let player = getPlayer(guildId, discordId);
  if (!player) {
    // New players land in the lowest division unplaced; an admin assigns the real one.
    const division = getLowestDivision(guildId);
    const startingMmr = division?.default_mmr ?? config.defaultMmr;
    db.prepare(
      `INSERT INTO players (guild_id, discord_id, username, division, mmr, wins, losses, streak, placed)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)`
    ).run(guildId, discordId, username, division?.division ?? 'C', startingMmr);
    player = getPlayer(guildId, discordId)!;
  } else if (player.username !== username) {
    db.prepare('UPDATE players SET username = ? WHERE guild_id = ? AND discord_id = ?').run(
      username,
      guildId,
      discordId
    );
    player.username = username;
  }
  return player;
}

/**
 * Fetches players by id within a guild, preserving the order of `discordIds`.
 *
 * SQL `IN` gives no ordering guarantee — SQLite serves it from the primary-key
 * index, so rows come back sorted by id. Callers rely on list order being meaningful
 * (queue slot numbers, and the captain being index 0 of a team), so re-order the rows
 * to match the request here rather than at every call site.
 */
export function getPlayersByIds(guildId: string, discordIds: string[]): Player[] {
  if (discordIds.length === 0) return [];
  const placeholders = discordIds.map(() => '?').join(',');
  const stmt = db.prepare(
    `SELECT * FROM players WHERE guild_id = ? AND discord_id IN (${placeholders})`
  );
  const rows = stmt.all(guildId, ...discordIds) as Player[];

  const byId = new Map(rows.map(p => [p.discord_id, p]));
  const ordered: Player[] = [];
  for (const id of discordIds) {
    const player = byId.get(id);
    if (player) ordered.push(player);
  }
  return ordered;
}

export function updatePlayerAfterMatch(
  guildId: string,
  discordId: string,
  mmrDelta: number,
  isWin: boolean
): void {
  const player = getPlayer(guildId, discordId);
  if (!player) return;

  const newMmr = Math.max(0, player.mmr + mmrDelta);
  const newWins = isWin ? player.wins + 1 : player.wins;
  const newLosses = isWin ? player.losses : player.losses + 1;

  let newStreak = player.streak;
  if (isWin) {
    newStreak = newStreak > 0 ? newStreak + 1 : 1;
  } else {
    newStreak = newStreak < 0 ? newStreak - 1 : -1;
  }

  db.prepare(
    'UPDATE players SET mmr = ?, wins = ?, losses = ?, streak = ? WHERE guild_id = ? AND discord_id = ?'
  ).run(newMmr, newWins, newLosses, newStreak, guildId, discordId);
}

export function applyGambleResultToPlayer(
  guildId: string,
  discordId: string,
  mmrChange: number,
  winChange: number,
  lossChange: number
): Player {
  const player = getPlayer(guildId, discordId);
  if (!player) throw new Error(`Player ${discordId} not found in guild ${guildId}`);

  const newMmr = Math.max(0, player.mmr + mmrChange);
  const newWins = Math.max(0, player.wins + winChange);
  const newLosses = Math.max(0, player.losses + lossChange);

  let newStreak = player.streak;
  if (winChange > 0) {
    newStreak = newStreak > 0 ? newStreak + 1 : 1;
  } else if (lossChange > 0) {
    newStreak = newStreak < 0 ? newStreak - 1 : -1;
  }

  db.prepare(
    'UPDATE players SET mmr = ?, wins = ?, losses = ?, streak = ? WHERE guild_id = ? AND discord_id = ?'
  ).run(newMmr, newWins, newLosses, newStreak, guildId, discordId);
  return getPlayer(guildId, discordId)!;
}

export function setPlayerMmr(guildId: string, discordId: string, newMmr: number): void {
  db.prepare('UPDATE players SET mmr = ? WHERE guild_id = ? AND discord_id = ?').run(
    newMmr,
    guildId,
    discordId
  );
}

/** Moves a player between divisions, optionally resetting them to the new division's default. */
export function setPlayerDivision(
  guildId: string,
  discordId: string,
  division: string,
  resetMmrToDefault = true
): Player | undefined {
  const target = getDivision(guildId, division);
  if (!target) throw new Error(`Division ${division} is not configured for guild ${guildId}`);

  if (resetMmrToDefault) {
    db.prepare(
      'UPDATE players SET division = ?, mmr = ?, placed = 1 WHERE guild_id = ? AND discord_id = ?'
    ).run(division, target.default_mmr, guildId, discordId);
  } else {
    db.prepare(
      'UPDATE players SET division = ?, placed = 1 WHERE guild_id = ? AND discord_id = ?'
    ).run(division, guildId, discordId);
  }
  return getPlayer(guildId, discordId);
}

/**
 * Leaderboard for one division, or for the whole guild when `division` is omitted.
 * Each division has its own ladder, so the divisionless form is only for admin views.
 */
export function getLeaderboard(
  guildId: string,
  division?: string,
  limit: number = 10,
  offset: number = 0
): Player[] {
  if (division) {
    return db
      .prepare(
        `SELECT * FROM players WHERE guild_id = ? AND division = ?
         ORDER BY mmr DESC, wins DESC LIMIT ? OFFSET ?`
      )
      .all(guildId, division, limit, offset) as Player[];
  }
  return db
    .prepare(
      'SELECT * FROM players WHERE guild_id = ? ORDER BY mmr DESC, wins DESC LIMIT ? OFFSET ?'
    )
    .all(guildId, limit, offset) as Player[];
}

export function getTotalPlayersCount(guildId: string, division?: string): number {
  const row = division
    ? (db
        .prepare('SELECT COUNT(*) as count FROM players WHERE guild_id = ? AND division = ?')
        .get(guildId, division) as { count: number } | undefined)
    : (db.prepare('SELECT COUNT(*) as count FROM players WHERE guild_id = ?').get(guildId) as
        | { count: number }
        | undefined);
  return row ? row.count : 0;
}

/** A player's position on their own division's ladder. */
export function getPlayerRank(
  guildId: string,
  discordId: string
): { rank: number; total: number; division: string } | undefined {
  const player = getPlayer(guildId, discordId);
  if (!player) return undefined;

  const rankRow = db
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM players
       WHERE guild_id = ? AND division = ? AND (mmr > ? OR (mmr = ? AND wins > ?))`
    )
    .get(guildId, player.division, player.mmr, player.mmr, player.wins) as { rank: number };

  return {
    rank: rankRow.rank,
    total: getTotalPlayersCount(guildId, player.division),
    division: player.division,
  };
}

// ==================== Division Queries ====================

export function getDivisions(guildId: string): GuildDivision[] {
  return db
    .prepare('SELECT * FROM guild_divisions WHERE guild_id = ? ORDER BY sort_order ASC')
    .all(guildId) as GuildDivision[];
}

export function getDivision(guildId: string, division: string): GuildDivision | undefined {
  return db
    .prepare('SELECT * FROM guild_divisions WHERE guild_id = ? AND division = ?')
    .get(guildId, division) as GuildDivision | undefined;
}

export function getLowestDivision(guildId: string): GuildDivision | undefined {
  return db
    .prepare('SELECT * FROM guild_divisions WHERE guild_id = ? ORDER BY sort_order ASC LIMIT 1')
    .get(guildId) as GuildDivision | undefined;
}

/** Resolves which division a queue channel belongs to, if it is a division channel. */
export function getDivisionByChannel(
  guildId: string,
  channelId: string
): GuildDivision | undefined {
  return db
    .prepare('SELECT * FROM guild_divisions WHERE guild_id = ? AND queue_channel_id = ?')
    .get(guildId, channelId) as GuildDivision | undefined;
}

export function updateDivision(
  guildId: string,
  division: string,
  updates: Partial<Pick<GuildDivision,
    'display_name' | 'default_mmr' | 'promote_at' | 'relegate_below' | 'queue_channel_id' | 'role_id'
  >>
): void {
  const fields = Object.keys(updates);
  if (fields.length === 0) return;
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  db.prepare(`UPDATE guild_divisions SET ${setClause} WHERE guild_id = ? AND division = ?`).run(
    ...fields.map(f => (updates as Record<string, unknown>)[f] ?? null),
    guildId,
    division
  );
}

// ==================== Season Queries ====================

export function getActiveSeason(guildId: string): Season | undefined {
  return db
    .prepare('SELECT * FROM seasons WHERE guild_id = ? AND is_active = 1 ORDER BY season_id DESC LIMIT 1')
    .get(guildId) as Season | undefined;
}

export function getSeasonHistory(guildId: string): Season[] {
  return db
    .prepare('SELECT * FROM seasons WHERE guild_id = ? ORDER BY season_id DESC')
    .all(guildId) as Season[];
}

export function createSeason(guildId: string, name: string): Season {
  const info = db
    .prepare('INSERT INTO seasons (guild_id, name) VALUES (?, ?)')
    .run(guildId, name);
  return db.prepare('SELECT * FROM seasons WHERE season_id = ?').get(info.lastInsertRowid) as Season;
}

export function getSeasonSnapshots(seasonId: number, division?: string): SeasonSnapshot[] {
  if (division) {
    return db
      .prepare(
        'SELECT * FROM season_snapshots WHERE season_id = ? AND division = ? ORDER BY final_rank ASC'
      )
      .all(seasonId, division) as SeasonSnapshot[];
  }
  return db
    .prepare('SELECT * FROM season_snapshots WHERE season_id = ? ORDER BY division, final_rank ASC')
    .all(seasonId) as SeasonSnapshot[];
}

// ==================== Queue Queries ====================

function parseQueueRow(row: any): ActiveQueue {
  return {
    channel_id: row.channel_id,
    guild_id: row.guild_id,
    message_id: row.message_id || undefined,
    player_ids: JSON.parse(row.player_ids),
    player_join_times: row.player_join_times ? JSON.parse(row.player_join_times) : {},
    state: row.state,
    ready_check_vc_id: row.ready_check_vc_id || undefined,
    vote_counts: JSON.parse(row.vote_counts || '{}'),
    draft_state: row.draft_state ? JSON.parse(row.draft_state) : undefined,
    captain_vote_state: row.captain_vote_state ? JSON.parse(row.captain_vote_state) : undefined,
    team_vote_state: row.team_vote_state ? JSON.parse(row.team_vote_state) : undefined,
  };
}

export function getQueue(channelId: string): ActiveQueue | undefined {
  const stmt = db.prepare('SELECT * FROM active_queues WHERE channel_id = ?');
  const row = stmt.get(channelId) as any;
  if (!row) return undefined;

  return parseQueueRow(row);
}

export function getAllQueues(): ActiveQueue[] {
  const stmt = db.prepare('SELECT * FROM active_queues');
  const rows = stmt.all() as any[];
  return rows.map(parseQueueRow);
}

export function saveQueue(queue: ActiveQueue): void {
  const stmt = db.prepare(`
    INSERT INTO active_queues (channel_id, guild_id, message_id, player_ids, state, vote_counts, draft_state, ready_check_vc_id, captain_vote_state, team_vote_state, player_join_times)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      message_id = excluded.message_id,
      player_ids = excluded.player_ids,
      state = excluded.state,
      vote_counts = excluded.vote_counts,
      draft_state = excluded.draft_state,
      ready_check_vc_id = excluded.ready_check_vc_id,
      captain_vote_state = excluded.captain_vote_state,
      team_vote_state = excluded.team_vote_state,
      player_join_times = excluded.player_join_times
  `);
  stmt.run(
    queue.channel_id,
    queue.guild_id,
    queue.message_id || null,
    JSON.stringify(queue.player_ids),
    queue.state,
    JSON.stringify(queue.vote_counts || {}),
    queue.draft_state ? JSON.stringify(queue.draft_state) : null,
    queue.ready_check_vc_id || null,
    queue.captain_vote_state ? JSON.stringify(queue.captain_vote_state) : null,
    queue.team_vote_state ? JSON.stringify(queue.team_vote_state) : null,
    queue.player_join_times ? JSON.stringify(queue.player_join_times) : null
  );
}

export function deleteQueue(channelId: string): void {
  db.prepare('DELETE FROM active_queues WHERE channel_id = ?').run(channelId);
}

export function updateQueueMessageId(channelId: string, messageId?: string): void {
  db.prepare('UPDATE active_queues SET message_id = ? WHERE channel_id = ?').run(messageId || null, channelId);
}

// ==================== Match Queries ====================

export function createMatch(data: {
  guild_id: string;
  channel_id: string;
  state?: 'READY_CHECK' | 'VOTING' | 'DRAFTING' | 'IN_PROGRESS';
  blue_team: string[];
  orange_team: string[];
  rl_name?: string;
  rl_pass?: string;
  blue_voice_id?: string;
  orange_voice_id?: string;
  message_id?: string;
  text_channel_id?: string;
  queue_channel_id?: string;
  feed_channel_id?: string;
  feed_message_id?: string;
  started_at?: string;
}): Match {
  const stmt = db.prepare(`
    INSERT INTO matches (
      guild_id, channel_id, state, blue_team, orange_team, rl_name, rl_pass,
      blue_voice_id, orange_voice_id, message_id, text_channel_id, queue_channel_id,
      feed_channel_id, feed_message_id, winner, report_status, gamble_status, started_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NONE', '{}', '{"state":"NONE","agreedPlayers":[]}', ?)
  `);
  const defaultStartedAt = data.started_at !== undefined ? data.started_at : ((data.state || 'IN_PROGRESS') === 'IN_PROGRESS' ? new Date().toISOString() : null);
  const res = stmt.run(
    data.guild_id,
    data.channel_id,
    data.state || 'IN_PROGRESS',
    JSON.stringify(data.blue_team),
    JSON.stringify(data.orange_team),
    data.rl_name || '',
    data.rl_pass || '',
    data.blue_voice_id || null,
    data.orange_voice_id || null,
    data.message_id || null,
    data.text_channel_id || null,
    data.queue_channel_id || null,
    data.feed_channel_id || null,
    data.feed_message_id || null,
    defaultStartedAt
  );

  return getMatch(Number(res.lastInsertRowid))!;
}

export function getMatch(matchId: number): Match | undefined {
  const stmt = db.prepare('SELECT * FROM matches WHERE match_id = ?');
  const row = stmt.get(matchId) as any;
  if (!row) return undefined;
  return parseMatchRow(row);
}

export function getMatchByTextChannel(textChannelId: string): Match | undefined {
  const stmt = db.prepare("SELECT * FROM matches WHERE text_channel_id = ? AND state IN ('READY_CHECK', 'VOTING', 'DRAFTING', 'IN_PROGRESS') ORDER BY created_at DESC");
  const row = stmt.get(textChannelId) as any;
  if (!row) return undefined;
  return parseMatchRow(row);
}

export function getActiveMatches(guildId: string): Match[] {
  const stmt = db.prepare("SELECT * FROM matches WHERE guild_id = ? AND state IN ('READY_CHECK', 'VOTING', 'DRAFTING', 'IN_PROGRESS') ORDER BY created_at DESC");
  const rows = stmt.all(guildId) as any[];
  return rows.map(parseMatchRow);
}

/**
 * The live match a player is in, within one guild.
 *
 * This used to scan every guild's active matches, which was merely wasteful while the bot
 * was single-tenant. Now that players are guild-scoped it would be a real bug: a match in
 * one server would block the same person from queuing in another.
 */
export function getActiveMatchForPlayer(guildId: string, discordId: string): Match | undefined {
  const stmt = db.prepare(
    "SELECT * FROM matches WHERE guild_id = ? AND state IN ('READY_CHECK', 'VOTING', 'DRAFTING', 'IN_PROGRESS')"
  );
  for (const r of stmt.all(guildId) as any[]) {
    const match = parseMatchRow(r);
    if (match.blue_team.includes(discordId) || match.orange_team.includes(discordId)) {
      return match;
    }
  }
  return undefined;
}

/**
 * All matches in a live state across every guild, used by the periodic stale-match sweep.
 */
export function getAllLiveMatches(): Match[] {
  const stmt = db.prepare(
    "SELECT * FROM matches WHERE state IN ('READY_CHECK', 'VOTING', 'CAPTAINS_VOTE', 'DRAFTING', 'IN_PROGRESS')"
  );
  return (stmt.all() as any[]).map(parseMatchRow);
}

export function getMatchHistory(guildId: string, limit: number = 5, discordId?: string): Match[] {
  if (discordId) {
    const stmt = db.prepare(`
      SELECT * FROM matches 
      WHERE guild_id = ? 
        AND state = 'COMPLETED'
        AND (blue_team LIKE ? OR orange_team LIKE ?)
      ORDER BY completed_at DESC, match_id DESC 
      LIMIT ?
    `);
    const pattern = `%"${discordId}"%`;
    const rows = stmt.all(guildId, pattern, pattern, limit) as any[];
    return rows.map(parseMatchRow);
  } else {
    const stmt = db.prepare(`
      SELECT * FROM matches 
      WHERE guild_id = ? 
        AND state = 'COMPLETED'
      ORDER BY completed_at DESC, match_id DESC 
      LIMIT ?
    `);
    const rows = stmt.all(guildId, limit) as any[];
    return rows.map(parseMatchRow);
  }
}

export function cancelAllActiveMatches(guildId: string): number {
  const stmt = db.prepare(`
    UPDATE matches 
    SET state = 'CANCELLED', winner = 'NONE', completed_at = ?
    WHERE guild_id = ? AND state IN ('READY_CHECK', 'VOTING', 'CAPTAINS_VOTE', 'DRAFTING', 'IN_PROGRESS')
  `);
  const res = stmt.run(new Date().toISOString(), guildId);
  return res.changes;
}

export function updateMatch(
  matchId: number,
  updates: {
    state?: 'READY_CHECK' | 'VOTING' | 'DRAFTING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
    winner?: 'BLUE' | 'ORANGE' | 'NONE';
    report_status?: {
      blueVotes?: string[];
      orangeVotes?: string[];
      cancelVotes?: string[];
      rerollVotes?: string[];
      seenMatchups?: string[];
    };
    gamble_status?: GambleStatus;
    message_id?: string;
    completed_at?: string;
    text_channel_id?: string;
    queue_channel_id?: string;
    feed_channel_id?: string;
    feed_message_id?: string;
    blue_voice_id?: string;
    orange_voice_id?: string;
    ready_check_vc_id?: string;
    blue_team?: string[];
    orange_team?: string[];
    rl_name?: string;
    rl_pass?: string;
    started_at?: string;
  }
): Match {
  const current = getMatch(matchId);
  if (!current) throw new Error(`Match ${matchId} not found`);

  const newState = updates.state || current.state;
  const newWinner = updates.winner || current.winner;
  const newReport = updates.report_status ? JSON.stringify(updates.report_status) : JSON.stringify(current.report_status);
  const newGamble = updates.gamble_status ? JSON.stringify(updates.gamble_status) : JSON.stringify(current.gamble_status || { state: 'NONE', agreedPlayers: [] });
  const newMessageId = updates.message_id !== undefined ? updates.message_id : current.message_id;
  const newCompletedAt = updates.completed_at || current.completed_at || null;
  const newStartedAt = updates.started_at !== undefined ? updates.started_at : (current.started_at || (newState === 'IN_PROGRESS' && current.state !== 'IN_PROGRESS' ? new Date().toISOString() : null));
  const newTextChan = updates.text_channel_id !== undefined ? updates.text_channel_id : current.text_channel_id;
  const newQueueChan = updates.queue_channel_id !== undefined ? updates.queue_channel_id : current.queue_channel_id;
  const newFeedChan = updates.feed_channel_id !== undefined ? updates.feed_channel_id : current.feed_channel_id;
  const newFeedMsg = updates.feed_message_id !== undefined ? updates.feed_message_id : current.feed_message_id;
  const newBlueVoice = updates.blue_voice_id !== undefined ? updates.blue_voice_id : current.blue_voice_id;
  const newOrangeVoice = updates.orange_voice_id !== undefined ? updates.orange_voice_id : current.orange_voice_id;
  const newReadyVc = updates.ready_check_vc_id !== undefined ? updates.ready_check_vc_id : current.ready_check_vc_id;
  const newBlueTeam = updates.blue_team ? JSON.stringify(updates.blue_team) : JSON.stringify(current.blue_team);
  const newOrangeTeam = updates.orange_team ? JSON.stringify(updates.orange_team) : JSON.stringify(current.orange_team);
  const newRlName = updates.rl_name !== undefined ? updates.rl_name : current.rl_name;
  const newRlPass = updates.rl_pass !== undefined ? updates.rl_pass : current.rl_pass;

  const stmt = db.prepare(`
    UPDATE matches SET
      state = ?,
      winner = ?,
      report_status = ?,
      gamble_status = ?,
      message_id = ?,
      completed_at = ?,
      text_channel_id = ?,
      queue_channel_id = ?,
      feed_channel_id = ?,
      feed_message_id = ?,
      blue_voice_id = ?,
      orange_voice_id = ?,
      ready_check_vc_id = ?,
      blue_team = ?,
      orange_team = ?,
      rl_name = ?,
      rl_pass = ?,
      started_at = ?
    WHERE match_id = ?
  `);
  stmt.run(
    newState,
    newWinner,
    newReport,
    newGamble,
    newMessageId,
    newCompletedAt,
    newTextChan || null,
    newQueueChan || null,
    newFeedChan || null,
    newFeedMsg || null,
    newBlueVoice || null,
    newOrangeVoice || null,
    newReadyVc || null,
    newBlueTeam,
    newOrangeTeam,
    newRlName,
    newRlPass,
    newStartedAt,
    matchId
  );
  return getMatch(matchId)!;
}

export function updateMatchGambleStatus(matchId: number, gambleStatus: GambleStatus): Match {
  return updateMatch(matchId, { gamble_status: gambleStatus });
}

/**
 * Atomically read-modify-writes a match's report_status.
 *
 * Vote handlers used to read the row, mutate the JSON in JS, then write the whole
 * row back. Two players clicking in the same tick both read the pre-vote state and
 * the second write silently dropped the first vote. better-sqlite3 is synchronous,
 * so running the read and the write inside one transaction genuinely serialises them.
 *
 * The mutator must be pure-synchronous — do not await inside it.
 */
export function mutateMatchReportStatus(
  matchId: number,
  mutate: (status: NonNullable<Match['report_status']>, match: Match) => void
): Match | undefined {
  return db.transaction(() => {
    const match = getMatch(matchId);
    if (!match) return undefined;

    const status = match.report_status || {};
    status.blueVotes = status.blueVotes || [];
    status.orangeVotes = status.orangeVotes || [];
    status.cancelVotes = status.cancelVotes || [];

    mutate(status, match);
    return updateMatch(matchId, { report_status: status });
  })();
}

/**
 * Atomically read-modify-writes a match's gamble_status. See mutateMatchReportStatus.
 */
export function mutateMatchGambleStatus(
  matchId: number,
  mutate: (status: GambleStatus, match: Match) => void
): Match | undefined {
  return db.transaction(() => {
    const match = getMatch(matchId);
    if (!match) return undefined;

    const status = match.gamble_status || { state: 'NONE' as const, agreedPlayers: [] };
    status.agreedPlayers = status.agreedPlayers || [];

    mutate(status, match);
    return updateMatch(matchId, { gamble_status: status });
  })();
}

/**
 * Atomically read-modify-writes a queue row. See mutateMatchReportStatus.
 * Returns the saved queue, or undefined if the queue no longer exists.
 */
export function mutateQueue(
  channelId: string,
  mutate: (queue: ActiveQueue) => void
): ActiveQueue | undefined {
  return db.transaction(() => {
    const queue = getQueue(channelId);
    if (!queue) return undefined;
    mutate(queue);
    saveQueue(queue);
    return queue;
  })();
}

export function getMatchGambleStatus(matchId: number): GambleStatus {
  const match = getMatch(matchId);
  return match?.gamble_status || { state: 'NONE', agreedPlayers: [] };
}

function parseMatchRow(row: any): Match {
  return {
    match_id: row.match_id,
    guild_id: row.guild_id,
    channel_id: row.channel_id,
    state: row.state,
    blue_team: JSON.parse(row.blue_team),
    orange_team: JSON.parse(row.orange_team),
    rl_name: row.rl_name,
    rl_pass: row.rl_pass,
    blue_voice_id: row.blue_voice_id || undefined,
    orange_voice_id: row.orange_voice_id || undefined,
    ready_check_vc_id: row.ready_check_vc_id || undefined,
    message_id: row.message_id || undefined,
    text_channel_id: row.text_channel_id || undefined,
    queue_channel_id: row.queue_channel_id || undefined,
    feed_channel_id: row.feed_channel_id || undefined,
    feed_message_id: row.feed_message_id || undefined,
    winner: row.winner,
    report_status: JSON.parse(row.report_status || '{}'),
    gamble_status: !row.gamble_status || row.gamble_status === '{}' ? { state: 'NONE', agreedPlayers: [] } : JSON.parse(row.gamble_status),
    created_at: row.created_at,
    completed_at: row.completed_at || undefined,
    started_at: row.started_at || undefined,
  };
}

export function isRlCredentialInUse(rlName: string, _rlPass: string): boolean {
  // Only check if any currently active match is using this lobby name
  const activeStmt = db.prepare("SELECT COUNT(*) as count FROM matches WHERE rl_name = ? AND state IN ('READY_CHECK', 'VOTING', 'CAPTAINS_VOTE', 'DRAFTING', 'IN_PROGRESS')");
  const activeRow = activeStmt.get(rlName) as { count: number } | undefined;
  return activeRow ? activeRow.count > 0 : false;
}

// ==================== Match Duration Query ====================

export function getAverageMatchDuration(discordId?: string): number {
  if (discordId) {
    const stmt = db.prepare(`
      SELECT AVG(
        (julianday(completed_at) - julianday(started_at)) * 86400
      ) as avg_seconds
      FROM matches
      WHERE state = 'COMPLETED'
        AND started_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND (blue_team LIKE '%' || ? || '%' OR orange_team LIKE '%' || ? || '%')
    `);
    const row = stmt.get(discordId, discordId) as { avg_seconds: number | null } | undefined;
    return row && row.avg_seconds ? Math.round(row.avg_seconds) : 0;
  } else {
    const stmt = db.prepare(`
      SELECT AVG(
        (julianday(completed_at) - julianday(started_at)) * 86400
      ) as avg_seconds
      FROM matches
      WHERE state = 'COMPLETED'
        AND started_at IS NOT NULL
        AND completed_at IS NOT NULL
    `);
    const row = stmt.get() as { avg_seconds: number | null } | undefined;
    return row && row.avg_seconds ? Math.round(row.avg_seconds) : 0;
  }
}

// ==================== Ban Queries ====================

export function createBan(
  guildId: string,
  discordId: string,
  bannedBy: string,
  reason: string,
  expiresAt: string | null
): Ban {
  const stmt = db.prepare(`
    INSERT INTO bans (guild_id, discord_id, banned_by, reason, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = stmt.run(guildId, discordId, bannedBy, reason, expiresAt);
  return getBanById(Number(info.lastInsertRowid))!;
}

export function getBanById(id: number): Ban | undefined {
  const stmt = db.prepare('SELECT * FROM bans WHERE id = ?');
  return stmt.get(id) as Ban | undefined;
}

export function getActiveBan(guildId: string, discordId: string): Ban | null {
  const stmt = db.prepare(`
    SELECT * FROM bans
    WHERE guild_id = ? AND discord_id = ? AND revoked = 0
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    ORDER BY created_at DESC LIMIT 1
  `);
  return (stmt.get(guildId, discordId) as Ban | undefined) || null;
}

export function revokeBan(guildId: string, discordId: string): boolean {
  const stmt = db.prepare(`
    UPDATE bans
    SET revoked = 1
    WHERE guild_id = ? AND discord_id = ? AND revoked = 0
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
  `);
  const info = stmt.run(guildId, discordId);
  return info.changes > 0;
}

export function getPlayerBanHistory(discordId: string, guildId?: string): Ban[] {
  if (guildId) {
    const stmt = db.prepare(`
      SELECT * FROM bans
      WHERE discord_id = ? AND guild_id = ?
      ORDER BY created_at DESC
    `);
    return stmt.all(discordId, guildId) as Ban[];
  }
  const stmt = db.prepare(`
    SELECT * FROM bans
    WHERE discord_id = ?
    ORDER BY created_at DESC
  `);
  return stmt.all(discordId) as Ban[];
}

export function getActiveBansByGuild(guildId: string): Ban[] {
  const stmt = db.prepare(`
    SELECT * FROM bans
    WHERE guild_id = ? AND revoked = 0
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    ORDER BY created_at DESC
  `);
  return stmt.all(guildId) as Ban[];
}


