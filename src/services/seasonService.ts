import db from '../database/db';
import {
  Player,
  Season,
  GuildDivision,
  getDivisions,
  getActiveSeason,
  createSeason,
} from '../database/queries';
import { SUPPORTED_TEAM_SIZES } from '../database/migrations';
import { logger } from '../utils/logger';

export type SeasonOutcome = 'PROMOTED' | 'RELEGATED' | 'STAYED';

export interface PlayerSeasonResult {
  discord_id: string;
  username: string;
  teamSize: number;
  fromDivision: string;
  toDivision: string;
  finalMmr: number;
  newMmr: number;
  finalRank: number;
  outcome: SeasonOutcome;
}

export interface SeasonEndResult {
  endedSeason: Season;
  newSeason: Season;
  results: PlayerSeasonResult[];
}

/**
 * Decides where a player ends the season, given their division's thresholds.
 *
 * Promotion and relegation are judged on final MMR against the division's own bounds --
 * a division with no promote_at is the top of the ladder, one with no relegate_below is
 * the bottom.
 */
export function resolveDivisionChange(
  player: Pick<Player, 'mmr' | 'division'>,
  ladder: GuildDivision[]
): { toDivision: string; outcome: SeasonOutcome } {
  const index = ladder.findIndex(d => d.division === player.division);
  if (index === -1) return { toDivision: player.division, outcome: 'STAYED' };

  const current = ladder[index];

  if (current.promote_at !== null && player.mmr >= current.promote_at && index < ladder.length - 1) {
    return { toDivision: ladder[index + 1].division, outcome: 'PROMOTED' };
  }
  if (current.relegate_below !== null && player.mmr < current.relegate_below && index > 0) {
    return { toDivision: ladder[index - 1].division, outcome: 'RELEGATED' };
  }
  return { toDivision: player.division, outcome: 'STAYED' };
}

/**
 * Ends the active season for a guild: snapshots every player, applies promotion and
 * relegation, then hard-resets everyone to their new division's default MMR.
 *
 * This is a hard reset by design -- not the ×0.5 compression toward a global baseline that
 * the old feature sketch described. Divisions each have their own default, so compressing
 * toward one number would collapse the ladder.
 *
 * One season spans every team size, so this walks all of them: 2v2, 3v3 and 4v4 each have
 * their own divisions, standings and promotion outcomes, and all reset together.
 *
 * The whole thing runs in a single transaction: a half-reset ranks table is unrecoverable
 * without going to the nightly backup.
 */
export function endSeason(guildId: string, nextSeasonName?: string): SeasonEndResult {
  const active = getActiveSeason(guildId);
  if (!active) {
    throw new Error(`No active season for guild ${guildId}.`);
  }

  const laddersBySize = new Map<number, GuildDivision[]>();
  for (const size of SUPPORTED_TEAM_SIZES) {
    const ladder = getDivisions(guildId, size);
    if (ladder.length > 0) laddersBySize.set(size, ladder);
  }
  if (laddersBySize.size === 0) {
    throw new Error(`Guild ${guildId} has no divisions configured.`);
  }

  return db.transaction(() => {
    const results: PlayerSeasonResult[] = [];

    const snapshot = db.prepare(`
      INSERT INTO season_snapshots
        (season_id, guild_id, discord_id, team_size, division, final_mmr, final_wins, final_losses, final_rank, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const resetPlayer = db.prepare(`
      UPDATE player_ladders SET division = ?, mmr = ?, wins = 0, losses = 0, streak = 0
      WHERE guild_id = ? AND team_size = ? AND discord_id = ?
    `);

    for (const [teamSize, ladder] of laddersBySize) {
      const defaultMmrFor = new Map(ladder.map(d => [d.division, d.default_mmr]));

      for (const division of ladder) {
        // Rank within (size, division), which is the ladder players actually competed on.
        const standings = db
          .prepare(
            `SELECT l.*, p.username FROM player_ladders l
             JOIN players p ON p.guild_id = l.guild_id AND p.discord_id = l.discord_id
             WHERE l.guild_id = ? AND l.team_size = ? AND l.division = ?
             ORDER BY l.mmr DESC, l.wins DESC, l.discord_id ASC`
          )
          .all(guildId, teamSize, division.division) as Player[];

        standings.forEach((player, i) => {
          const finalRank = i + 1;
          const { toDivision, outcome } = resolveDivisionChange(player, ladder);
          const newMmr = defaultMmrFor.get(toDivision) ?? player.mmr;

          snapshot.run(
            active.season_id,
            guildId,
            player.discord_id,
            teamSize,
            player.division,
            player.mmr,
            player.wins,
            player.losses,
            finalRank,
            outcome
          );
          resetPlayer.run(toDivision, newMmr, guildId, teamSize, player.discord_id);

          results.push({
            discord_id: player.discord_id,
            username: player.username,
            teamSize,
            fromDivision: player.division,
            toDivision,
            finalMmr: player.mmr,
            newMmr,
            finalRank,
            outcome,
          });
        });
      }
    }

    db.prepare(
      `UPDATE seasons SET is_active = 0, ended_at = ? WHERE season_id = ?`
    ).run(new Date().toISOString(), active.season_id);

    const nextName = nextSeasonName || nextSeasonNameAfter(active.name);
    const newSeason = createSeason(guildId, nextName);

    logger.info(
      `Guild ${guildId}: ended "${active.name}" (${results.length} ladder placements), started "${nextName}". ` +
        `${results.filter(r => r.outcome === 'PROMOTED').length} promoted, ` +
        `${results.filter(r => r.outcome === 'RELEGATED').length} relegated.`
    );

    return { endedSeason: active, newSeason, results };
  })();
}

/** "Season 3" -> "Season 4". Falls back to a dated name for anything non-numeric. */
export function nextSeasonNameAfter(currentName: string): string {
  const match = currentName.match(/^(.*?)(\d+)$/);
  if (match) {
    return `${match[1]}${parseInt(match[2], 10) + 1}`;
  }
  const now = new Date();
  return `Season ${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
