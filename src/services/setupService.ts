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
import { getDivisions, updateDivision, getQueue, GuildDivision } from '../database/queries';
import { SUPPORTED_TEAM_SIZES, DIVISIONS } from '../database/migrations';
import { invalidateDivisionNames } from './divisionNames';
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
 *   - a category called `━━━━━  Rank C  ━━━━━` (a plain `Rank C` is recognised too), where its match channels
 *     will also be created -- match channels go in the queue channel's category;
 *   - a text channel `rank-c-3v3` inside it, registered as that ladder's queue channel,
 *     with the queue panel posted;
 *   - optionally a role `Rank C`, stored on the division, with the category visible only
 *     to that role. The bot's own join gate enforces divisions regardless; the role just
 *     keeps the wrong rank's chatter out of the channel.
 *
 * Which divisions: a six-man server does not want five ladders. `one` gives a single
 * ladder (Rank C, the entry division, so promotion never fires), `three` gives C/B/A,
 * `all` gives C/B/A/X/S. Categories and roles are made highest rank first so the sidebar
 * reads S -> C, and existing rank categories are re-sorted into that order as a block.
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
  /**
   * One-ladder servers only: what to call the ladder. "Rank C" means nothing when there
   * is no B. Applied to division C on every size, since such a server has one ladder per
   * size and they should all read the same.
   */
  name?: string;
}

export const DEFAULT_LADDER_NAME = '6mans';

/**
 * The preset a server is already on, read from which divisions have a queue channel
 * registered -- this size first, then any size, since a server set up as three ladders at
 * 3v3 wants three at 2v2 too. Undefined for a server nothing has been set up on yet.
 *
 * This is what a re-run without `divisions` should assume. It used to assume `one`, and
 * `one` renames division C to the ladder name, so an admin re-running `/setup roles:true`
 * on a three-ladder server to add the roles got Rank C turned into "6mans" everywhere.
 */
export function inferPreset(guildId: string, teamSize: number): DivisionPreset | undefined {
  const registeredOn = (size: number) =>
    new Set(getDivisions(guildId, size).filter(d => d.queue_channel_id).map(d => d.division));
  const sizes = [teamSize, ...SUPPORTED_TEAM_SIZES.filter(s => s !== teamSize)];
  for (const size of sizes) {
    const registered = registeredOn(size);
    if (registered.size === 0) continue;
    if (PRESET_DIVISIONS.all.some(d => !PRESET_DIVISIONS.three.includes(d) && registered.has(d))) return 'all';
    if (PRESET_DIVISIONS.three.some(d => !PRESET_DIVISIONS.one.includes(d) && registered.has(d))) return 'three';
    return 'one';
  }
  return undefined;
}

/** What the bot needs in a queue channel: see it, post the panel (image + buttons), keep it re-posted. */
const BOT_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ReadMessageHistory,
];

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

/** `━━━━━  Rank S  ━━━━━` -- Chris's sidebar style. The plain name is still recognised. */
export function categoryName(d: Pick<GuildDivision, 'display_name'>): string {
  return `━━━━━  ${d.display_name}  ━━━━━`;
}

/** True for both the decorated and the plain spelling of a division's category. */
export function isCategoryFor(name: string, d: Pick<GuildDivision, 'display_name'>): boolean {
  return name.replace(/━/g, '').trim().toLowerCase() === d.display_name.toLowerCase();
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

  // Renaming happens before anything is looked up, and the old name is kept so that a
  // category or channel made under it can be found and renamed rather than duplicated.
  //
  // Division C carries the ladder name on a one-ladder server and its rank name on any
  // other, and switching preset has to switch the name with it: a server that was set up
  // as "6mans" and then chose three ladders used to get categories called 6mans, Rank B,
  // Rank A. Both directions are the same rename, on every size, because the sizes all
  // share the one name.
  const previousNames = new Map<string, string>();
  const nameForC =
    opts.preset === 'one'
      ? (opts.name ?? DEFAULT_LADDER_NAME).trim()
      : DIVISIONS.find(d => d.division === 'C')!.displayName;
  for (const size of SUPPORTED_TEAM_SIZES) {
    const row = getDivisions(guild.id, size).find(d => d.division === 'C');
    if (row && row.display_name !== nameForC) {
      if (size === opts.teamSize) previousNames.set('C', row.display_name);
      updateDivision(guild.id, size, 'C', { display_name: nameForC });
    }
  }
  invalidateDivisionNames(guild.id);

  const wanted = PRESET_DIVISIONS[opts.preset];
  const divisions = getDivisions(guild.id, opts.teamSize).filter(d => wanted.includes(d.division));
  if (divisions.length === 0) {
    report.warnings.push(`No divisions exist for ${formatTeamSize(opts.teamSize)} on this server.`);
    return report;
  }

  // Highest rank first: Discord appends new categories at the bottom, so creating S before
  // X before A ... lands them in sidebar order, and the roles list reads the same way.
  divisions.sort((a, b) => b.sort_order - a.sort_order);
  const categories: CategoryChannel[] = [];

  for (const d of divisions) {
    const previous = previousNames.get(d.division);
    const wasCalled = (n: string) => previous !== undefined && isCategoryFor(n, { display_name: previous });

    // Role first, so the category can be locked to it as it is created.
    let role: Role | undefined;
    if (opts.roles) {
      const existing = (d.role_id && guild.roles.cache.get(d.role_id)) || guild.roles.cache.find(r => r.name === d.display_name);
      if (existing) {
        role = existing;
        if (previous !== undefined && existing.name === previous) {
          await existing.setName(d.display_name, '6mans /setup rename');
          note(false, `role **${existing.name}** (renamed from ${previous})`);
        } else {
          note(false, `role **${existing.name}**`);
        }
      } else {
        role = await guild.roles.create({ name: d.display_name, mentionable: false, reason: '6mans /setup' });
        note(true, `role **${role.name}**`);
      }
      if (d.role_id !== role.id) updateDivision(guild.id, opts.teamSize, d.division, { role_id: role.id });
    }

    // Category: by name. Match channels are created inside the queue channel's category,
    // so this is where a division's games live too.
    // The category the registered queue channel sits in counts too: after a rename it is
    // the one to keep, whatever it is called.
    const registeredChannel = d.queue_channel_id ? guild.channels.cache.get(d.queue_channel_id) : undefined;
    const registeredParent =
      registeredChannel && 'parentId' in registeredChannel && registeredChannel.parentId
        ? (guild.channels.cache.get(registeredChannel.parentId) as CategoryChannel | undefined)
        : undefined;
    let category =
      (registeredParent && (isCategoryFor(registeredParent.name, d) || wasCalled(registeredParent.name)) ? registeredParent : undefined) ??
      (guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && (isCategoryFor(c.name, d) || wasCalled(c.name))
      ) as CategoryChannel | undefined);
    if (category) {
      if (wasCalled(category.name) && !isCategoryFor(category.name, d)) {
        const from = category.name;
        await category.setName(categoryName(d), '6mans /setup rename');
        note(false, `category **${category.name}** (renamed from ${from})`);
      } else {
        note(false, `category **${category.name}**`);
      }
    } else {
      category = (await guild.channels.create({
        name: categoryName(d),
        type: ChannelType.GuildCategory,
        reason: '6mans /setup',
      })) as CategoryChannel;
      note(true, `category **${category.name}**`);
    }
    categories.push(category);

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
      // Only a channel still carrying the auto-generated old name is renamed; a name an
      // admin chose is theirs.
      if (previous !== undefined && channel.name === queueChannelName({ display_name: previous }, opts.teamSize)) {
        await channel.setName(name, '6mans /setup rename');
        note(false, `queue channel <#${channel.id}> (renamed)`);
      } else {
        note(false, `queue channel <#${channel.id}> (already registered)`);
      }
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
          // The bot's own access, explicitly. A new channel inherits its category's
          // overwrites, and on a server where an admin has made the category private the
          // bot would otherwise create a channel it cannot post the panel in.
          permissionOverwrites: [{ id: client.user!.id, type: OverwriteType.Member, allow: BOT_CHANNEL_PERMISSIONS }],
          reason: '6mans /setup',
        })) as TextChannel;
        note(true, `queue channel <#${channel.id}>`);
      }
    }
    // Same for a channel that already existed: make sure the bot can post in it. Best
    // effort -- a channel the bot cannot even see cannot be edited by it either, and
    // that case is reported below when the panel fails to post.
    await channel.permissionOverwrites
      .edit(
        client.user!.id,
        { ViewChannel: true, SendMessages: true, AttachFiles: true, EmbedLinks: true, ManageMessages: true, ReadMessageHistory: true },
        { reason: '6mans /setup' }
      )
      .catch(() => undefined);

    await registerQueueChannel(client, guild.id, channel.id, opts.teamSize, d.division);
    // refreshQueuePanel logs and swallows a failed post; the stored message id is the proof.
    if (!getQueue(channel.id)?.message_id) {
      report.warnings.push(
        `The panel could not be posted in <#${channel.id}> — the bot cannot see or send there. ` +
          "Check the category's permissions, give the bot **View Channel** and **Send Messages**, then run `/setup` again."
      );
    }
  }

  // Existing categories keep whatever order an admin left them in, which after a partial
  // run can be C above S. Put the rank block back in S -> C order, starting from wherever
  // the block's topmost category already sits, so nothing else in the sidebar moves.
  if (categories.length > 1) {
    const top = Math.min(...categories.map(c => c.position ?? 0));
    await guild.channels
      .setPositions(categories.map((c, i) => ({ channel: c.id, position: top + i })))
      .catch(err => {
        report.warnings.push(`Could not reorder the rank categories: ${describe(err)}`);
      });
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
