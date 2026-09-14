import { Client } from 'discord.js';
import { getDivision } from '../database/queries';
import { PlayerSeasonResult } from './seasonService';
import { logger } from '../utils/logger';

export interface RoleSyncReport {
  /** Members whose roles were changed. */
  moved: number;
  /** Moves that needed a role change but could not get one: no role configured, or the member is gone. */
  skipped: number;
}

/**
 * Moves promoted and relegated players onto their new division's Discord role.
 *
 * The role is what lets a player see their division's queue channel, so a promotion that
 * only changed the database left them locked out of the queue they had just earned.
 *
 * /setup makes one role per division *name* and shares it across sizes -- "Rank C" is the
 * same role for 2v2 and 3v3. So a player holds the role of every division they are in on
 * any size: promoted to B in 3v3 while still C in 2v2 gains Rank B and keeps Rank C. This
 * works that out per player across all of their moves before touching Discord.
 *
 * Divisions without a role (a server that ran /setup without roles) are skipped silently;
 * a member who has since left the server is skipped too. Neither stops the rest.
 */
export async function syncDivisionRoles(
  client: Client,
  guildId: string,
  results: PlayerSeasonResult[]
): Promise<RoleSyncReport> {
  const report: RoleSyncReport = { moved: 0, skipped: 0 };

  const moved = results.filter(r => r.fromDivision !== r.toDivision);
  if (moved.length === 0) return report;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    report.skipped = moved.length;
    return report;
  }

  // Per player: every role they should now hold, and every role they held for a division
  // they left. A role in both sets stays -- they are still in that division on some size.
  const byPlayer = new Map<string, { keep: Set<string>; drop: Set<string> }>();
  const roleFor = (teamSize: number, division: string) => getDivision(guildId, teamSize, division)?.role_id;

  for (const r of results) {
    const entry = byPlayer.get(r.discord_id) ?? { keep: new Set<string>(), drop: new Set<string>() };
    const to = roleFor(r.teamSize, r.toDivision);
    if (to) entry.keep.add(to);
    if (r.fromDivision !== r.toDivision) {
      const from = roleFor(r.teamSize, r.fromDivision);
      if (from) entry.drop.add(from);
    }
    byPlayer.set(r.discord_id, entry);
  }

  for (const [discordId, { keep, drop }] of byPlayer) {
    const toRemove = [...drop].filter(id => !keep.has(id));
    const toAdd = [...keep];
    const involved = moved.some(r => r.discord_id === discordId);
    if (!involved) continue;
    if (toAdd.length === 0 && toRemove.length === 0) {
      report.skipped += 1;
      continue;
    }

    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) {
      report.skipped += 1;
      continue;
    }

    try {
      const missing = toAdd.filter(id => !member.roles.cache.has(id));
      const held = toRemove.filter(id => member.roles.cache.has(id));
      if (missing.length > 0) await member.roles.add(missing, '6mans season reset');
      if (held.length > 0) await member.roles.remove(held, '6mans season reset');
      report.moved += 1;
    } catch (err) {
      logger.warn(`Season reset: could not update roles for ${discordId} in ${guildId}:`, err);
      report.skipped += 1;
    }
  }

  return report;
}
