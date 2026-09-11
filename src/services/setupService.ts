import {
  Client,
  Guild,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  CategoryChannel,
  TextChannel,
  Role,
} from 'discord.js';
import { getDivisions, updateDivision, GuildDivision } from '../database/queries';
import { ensureGuildDefaults } from './guildSetup';
import { registerQueueChannel } from './queuePanel';
import { findFeedChannel } from './channelService';
import { formatTeamSize } from '../ui/teamSize';
import { logger } from '../utils/logger';

/**
 * One-command onboarding for a new server.
 *
 * Before this, setting a server up meant knowing to make a category per division, put a
 * text channel in each, run `/queue panel division:X` in every one, and optionally make
 * the roles -- the exact list of things the first trial server would have got wrong.
 * `/setup` does all of it, and is safe to run again: everything it makes is looked up by
 * name (or by the channel id already registered on the division) before it is created, so
 * a second run repairs what is missing and touches nothing that exists.
 *
 * What one division gets:
 *   - a category called `Rank C` (the division's display name), where its match channels
 *     will also be created -- match channels go in the queue channel's category;
 *   - a text channel `rank-c-3v3` inside it, registered as that ladder's queue channel,
 *     with the queue panel posted;
 *   - optionally a role `Rank C`, stored on the division, with the category visible only
 *     to that role. The bot's own join gate enforces divisions regardless; the role just
 *     keeps the wrong rank's chatter out of the channel.
 *
 * Which divisions: a six-man server does not want five ladders. `one` gives a single
 * ladder (Rank C, the entry division, so promotion never fires), `three` gives C/B/A,
 * `all` gives C/B/A/X/S.
 */

export type DivisionPreset = 'one' | 'three' | 'all';

export const PRESET_DIVISIONS: Record<DivisionPreset, string[]> = {
  one: ['C'],
  three: ['C', 'B', 'A'],
  all: ['C', 'B', 'A', 'X', 'S'],
};

export interface SetupOptions {
  teamSize: number;
  preset: DivisionPreset;
  /** Make a role per division and restrict its category to that role. */
  roles: boolean;
  /** Make a public #active-matches channel for the match feed. */
  feed: boolean;
}

export interface SetupReport {
  /** One line per thing, in the order it was handled. */
  lines: string[];
  created: number;
  reused: number;
  /** Problems that did not stop the run. */
  warnings: string[];
}

/** Permissions the bot needs for a run; ManageRoles only when roles are requested. */
export function missingBotPermissions(guild: Guild, roles: boolean): string[] {
  const me = guild.members.me;
  if (!me) return ['(could not read the bot\'s own permissions)'];
  if (me.permissions.has(PermissionFlagsBits.Administrator)) return [];
  const needed: Array<[bigint, string]> = [
    [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    [PermissionFlagsBits.ViewChannel, 'View Channels'],
    [PermissionFlagsBits.SendMessages, 'Send Messages'],
    [PermissionFlagsBits.AttachFiles, 'Attach Files'],
  ];
  if (roles) needed.push([PermissionFlagsBits.ManageRoles, 'Manage Roles']);
  return needed.filter(([flag]) => !me.permissions.has(flag)).map(([, name]) => name);
}

export function queueChannelName(d: Pick<GuildDivision, 'display_name'>, teamSize: number): string {
  return `${d.display_name}-${formatTeamSize(teamSize)}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function runSetup(client: Client, guild: Guild, opts: SetupOptions): Promise<SetupReport> {
  const report: SetupReport = { lines: [], created: 0, reused: 0, warnings: [] };
  const note = (created: boolean, what: string) => {
    report.lines.push(`${created ? '🆕' : '↩️'} ${what}`);
    if (created) report.created += 1;
    else report.reused += 1;
  };

  // A guild that joined after the seed ran has no division rows; the seed is idempotent.
  ensureGuildDefaults(guild.id);

  const wanted = PRESET_DIVISIONS[opts.preset];
  const divisions = getDivisions(guild.id, opts.teamSize).filter(d => wanted.includes(d.division));
  if (divisions.length === 0) {
    report.warnings.push(`No divisions exist for ${formatTeamSize(opts.teamSize)} on this server.`);
    return report;
  }

  for (const d of divisions) {
    // Role first, so the category can be locked to it as it is created.
    let role: Role | undefined;
    if (opts.roles) {
      const existing = (d.role_id && guild.roles.cache.get(d.role_id)) || guild.roles.cache.find(r => r.name === d.display_name);
      if (existing) {
        role = existing;
        note(false, `role **${existing.name}**`);
      } else {
        role = await guild.roles.create({ name: d.display_name, mentionable: false, reason: '6mans /setup' });
        note(true, `role **${role.name}**`);
      }
      if (d.role_id !== role.id) updateDivision(guild.id, opts.teamSize, d.division, { role_id: role.id });
    }

    // Category: by name. Match channels are created inside the queue channel's category,
    // so this is where a division's games live too.
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === d.display_name.toLowerCase()
    ) as CategoryChannel | undefined;
    if (category) {
      note(false, `category **${category.name}**`);
    } else {
      category = (await guild.channels.create({
        name: d.display_name,
        type: ChannelType.GuildCategory,
        reason: '6mans /setup',
      })) as CategoryChannel;
      note(true, `category **${category.name}**`);
    }

    if (role) {
      // Only the division's role (and the bot) sees the category; children inherit unless
      // they say otherwise, and match channels always say otherwise.
      await category.permissionOverwrites
        .set([
          { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
          { id: role.id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] },
          { id: client.user!.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels] },
        ])
        .catch(err => {
          report.warnings.push(`Could not lock **${category!.name}** to its role: ${describe(err)}`);
        });
    }

    // Queue channel: the one already registered wins if it still exists (an admin may
    // have renamed or moved it); otherwise by name inside the category; otherwise new.
    const registered = d.queue_channel_id ? guild.channels.cache.get(d.queue_channel_id) : undefined;
    const name = queueChannelName(d, opts.teamSize);
    let channel: TextChannel | undefined;
    if (registered && registered.type === ChannelType.GuildText) {
      channel = registered as TextChannel;
      note(false, `queue channel <#${channel.id}> (already registered)`);
    } else {
      const byName = guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && c.name === name && (c as TextChannel).parentId === category!.id
      ) as TextChannel | undefined;
      if (byName) {
        channel = byName;
        note(false, `queue channel <#${channel.id}>`);
      } else {
        channel = (await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: category.id,
          topic: `${d.display_name} ${formatTeamSize(opts.teamSize)} queue — click Join Queue on the panel`,
          reason: '6mans /setup',
        })) as TextChannel;
        note(true, `queue channel <#${channel.id}>`);
      }
    }

    await registerQueueChannel(client, guild.id, channel.id, opts.teamSize, d.division);
  }

  if (opts.feed) {
    const existing = await findFeedChannel(guild);
    if (existing) {
      note(false, `feed channel <#${existing.id}>`);
    } else {
      const feed = await guild.channels.create({
        name: 'active-matches',
        type: ChannelType.GuildText,
        topic: 'Live 6mans matches, posted by the bot',
        reason: '6mans /setup',
      });
      note(true, `feed channel <#${feed.id}>`);
    }
  }

  logger.info(`Guild ${guild.id}: /setup ${opts.preset}/${formatTeamSize(opts.teamSize)} -- ${report.created} created, ${report.reused} reused.`);
  return report;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
