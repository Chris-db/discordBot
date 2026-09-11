import { describe, it, expect, beforeEach } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import db from '../src/database/db';
import { getDivisions, getQueue, updateDivision } from '../src/database/queries';
import { runSetup, missingBotPermissions, queueChannelName, categoryName, isCategoryFor, PRESET_DIVISIONS } from '../src/services/setupService';
import { withGuildTheme } from '../src/services/themeService';
import { getDivisionTier } from '../src/services/mmrService';
import { clearDivisionNamesCache, invalidateDivisionNames } from '../src/services/divisionNames';
import { setupCommand } from '../src/commands/setup';
import { commands } from '../src/handlers/commandHandler';

/**
 * /setup builds a server in one go and must be safe to run twice. The fake guild below
 * records every create call and answers cache lookups from what it has made, so a second
 * run can be checked for creating nothing.
 */

const G = 'guild_setup_test';

interface FakeChannel {
  id: string;
  name: string;
  type: ChannelType;
  position: number;
  parentId?: string | null;
  permissionOverwrites: { set: (o: any[]) => Promise<void>; edit: (id: string, o: any) => Promise<void>; last?: any[]; edited?: any };
  setName: (n: string) => Promise<void>;
  /** Set to make send() fail, like a channel the bot cannot see. */
  sendFails?: boolean;
  send: (o: any) => Promise<{ id: string }>;
  messages: { edit: () => Promise<null>; delete: () => Promise<null> };
  lastMessageId: string | null;
}

function fakeGuild(opts: { admin?: boolean; perms?: bigint[]; privateCategories?: boolean } = {}) {
  let nextId = 1;
  const channels = new Map<string, FakeChannel>();
  const roles = new Map<string, { id: string; name: string; setName: (n: string) => Promise<void> }>();
  const created: string[] = [];
  const positions: Array<{ channel: string; position: number }[]> = [];
  const cacheOf = <T>(m: Map<string, T>) => ({
    get: (id: string) => m.get(id),
    find: (fn: (c: T) => boolean) => [...m.values()].find(fn),
  });
  const perms = new Set((opts.perms ?? [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageRoles]).map(String));
  const guild = {
    id: G,
    name: 'Test',
    roles: {
      everyone: { id: 'everyone' },
      cache: cacheOf(roles),
      create: async ({ name }: { name: string }) => {
        const r = { id: `role_${nextId++}`, name, setName: async (n: string) => void (r.name = n) };
        roles.set(r.id, r);
        created.push(`role:${name}`);
        return r;
      },
    },
    channels: {
      cache: cacheOf(channels),
      create: async ({ name, type, parent, permissionOverwrites = [] }: { name: string; type: ChannelType; parent?: string; permissionOverwrites?: any[] }) => {
        const c: FakeChannel = {
          id: `chan_${nextId++}`,
          name,
          type,
          position: channels.size,
          parentId: parent ?? null,
          permissionOverwrites: {
            set: async (o: any[]) => {
              c.permissionOverwrites.last = o;
            },
            edit: async (id: string, o: any) => {
              if (c.sendFails) throw new Error('Missing Access');
              c.permissionOverwrites.edited = { id, ...o };
            },
          },
          setName: async (n: string) => void (c.name = n),
          // A private category makes its children unreachable unless the channel itself
          // carries an overwrite for the bot -- which is what /setup must add.
          sendFails: Boolean(opts.privateCategories && parent && !permissionOverwrites.some((o: any) => o.id === 'bot_1')),
          send: async () => {
            if (c.sendFails) throw new Error('Missing Access');
            return { id: `msg_${nextId++}` };
          },
          messages: { edit: async () => null, delete: async () => null },
          lastMessageId: null,
        };
        channels.set(c.id, c);
        created.push(`${type === ChannelType.GuildCategory ? 'category' : 'text'}:${name}`);
        return c;
      },
      setPositions: async (list: { channel: string; position: number }[]) => {
        positions.push(list);
        for (const { channel, position } of list) channels.get(channel)!.position = position;
      },
    },
    members: {
      me: {
        permissions: {
          has: (flag: bigint) => (opts.admin && flag === PermissionFlagsBits.Administrator) || perms.has(String(flag)),
        },
      },
    },
  };
  const client = {
    user: { id: 'bot_1' },
    channels: { fetch: async (id: string) => channels.get(id) ?? null },
    guilds: { fetch: async () => null },
    users: { fetch: async () => null },
  } as any;
  return { guild: guild as any, client, created, channels, roles, positions };
}

beforeEach(() => {
  clearDivisionNamesCache();
  db.exec(
    `DELETE FROM active_queues WHERE guild_id = '${G}'; DELETE FROM guild_divisions WHERE guild_id = '${G}';
     DELETE FROM guild_config WHERE guild_id = '${G}'; DELETE FROM seasons WHERE guild_id = '${G}';`
  );
});

describe('runSetup', () => {
  it('one ladder: a category, a registered queue channel with a queue row, and the feed', async () => {
    const { guild, client, created } = fakeGuild();
    const report = await runSetup(client, guild, { teamSize: 3, preset: 'one', roles: false, feed: true });

    expect(created).toEqual([`category:${categoryName({ display_name: '6mans' })}`, 'text:6mans-3v3', 'text:active-matches']);
    expect(report.created).toBe(3);
    expect(report.reused).toBe(0);
    expect(report.warnings).toEqual([]);

    const c = getDivisions(G, 3).find(d => d.division === 'C')!;
    expect(c.queue_channel_id).toBeTruthy();
    expect(getQueue(c.queue_channel_id!)).toMatchObject({ guild_id: G, team_size: 3, player_ids: [] });
    // Other divisions exist (seeded) but were not given channels.
    expect(getDivisions(G, 3).filter(d => d.queue_channel_id)).toHaveLength(1);
  });

  it('is idempotent: a second run creates nothing and reports everything as reused', async () => {
    const { guild, client, created } = fakeGuild();
    await runSetup(client, guild, { teamSize: 3, preset: 'three', roles: true, feed: true });
    const firstCount = created.length;
    expect(firstCount).toBe(3 * 3 + 1); // role + category + channel per division, plus feed

    const again = await runSetup(client, guild, { teamSize: 3, preset: 'three', roles: true, feed: true });
    expect(created.length).toBe(firstCount);
    expect(again.created).toBe(0);
    expect(again.reused).toBe(firstCount);
  });

  it('all five, with roles: each category is locked to its role and the role is stored', async () => {
    const { guild, client, created, channels, roles } = fakeGuild();
    await runSetup(client, guild, { teamSize: 2, preset: 'all', roles: true, feed: false });

    // Highest rank first, so the sidebar and the role list read S -> C.
    expect(created.filter(c => c.startsWith('role:'))).toEqual(['role:Rank S', 'role:Rank X', 'role:Rank A', 'role:Rank B', 'role:Rank C']);
    expect(created).not.toContain('text:active-matches');
    for (const d of getDivisions(G, 2)) {
      expect(d.role_id).toBeTruthy();
      expect(roles.get(d.role_id!)!.name).toBe(d.display_name);
      const category = [...channels.values()].find(c => c.type === ChannelType.GuildCategory && c.name === categoryName(d))!;
      expect(category.name).toBe(`━━━━━  ${d.display_name}  ━━━━━`);
      const overwrites = category.permissionOverwrites.last!;
      expect(overwrites.find((o: any) => o.id === 'everyone').deny).toEqual([PermissionFlagsBits.ViewChannel]);
      expect(overwrites.find((o: any) => o.id === d.role_id).allow).toEqual([PermissionFlagsBits.ViewChannel]);
      const queue = channels.get(d.queue_channel_id!)!;
      expect(queue.parentId).toBe(category.id);
      expect(queue.name).toBe(`rank-${d.division.toLowerCase()}-2v2`);
    }
  });

  it('keeps a channel an admin already registered (and renamed) instead of making a new one', async () => {
    const { guild, client, created, channels } = fakeGuild();
    const custom = await guild.channels.create({ name: 'my-own-queue', type: ChannelType.GuildText });
    created.length = 0;
    const { ensureGuildDefaults } = await import('../src/services/guildSetup');
    ensureGuildDefaults(G);
    updateDivision(G, 3, 'C', { queue_channel_id: custom.id });

    const report = await runSetup(client, guild, { teamSize: 3, preset: 'one', roles: false, feed: false });
    expect(created).toEqual([`category:${categoryName({ display_name: '6mans' })}`]);
    expect(channels.get(custom.id)!.name).toBe('my-own-queue'); // an admin's name is theirs
    expect(report.lines.join('\n')).toContain(`<#${custom.id}> (already registered)`);
    expect(getDivisions(G, 3).find(d => d.division === 'C')!.queue_channel_id).toBe(custom.id);
    expect(channels.size).toBe(2);
  });

  it('sizes are independent: 3v3 then 2v2 gives each its own channel and ladder', async () => {
    const { guild, client, created } = fakeGuild();
    await runSetup(client, guild, { teamSize: 3, preset: 'one', roles: false, feed: false });
    await runSetup(client, guild, { teamSize: 2, preset: 'one', roles: false, feed: false });
    expect(created).toEqual([`category:${categoryName({ display_name: '6mans' })}`, 'text:6mans-3v3', 'text:6mans-2v2']);
    const c3 = getDivisions(G, 3).find(d => d.division === 'C')!;
    const c2 = getDivisions(G, 2).find(d => d.division === 'C')!;
    expect(c3.queue_channel_id).not.toBe(c2.queue_channel_id);
    expect(getQueue(c2.queue_channel_id!)!.team_size).toBe(2);
  });

  it('a role that cannot lock its category is a warning, not a failure', async () => {
    const { guild, client, channels } = fakeGuild();
    const origCreate = guild.channels.create;
    guild.channels.create = async (o: any) => {
      const c = await origCreate(o);
      if (o.type === ChannelType.GuildCategory) {
        c.permissionOverwrites.set = async () => {
          throw new Error('Missing Permissions');
        };
      }
      return c;
    };
    const report = await runSetup(client, guild, { teamSize: 3, preset: 'one', roles: true, feed: false });
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('Missing Permissions');
    expect(channels.size).toBe(2);
  });
});

describe('one-ladder naming', () => {
  it('names the ladder (default 6mans) on every size, and the cards pick it up', async () => {
    const { guild, client } = fakeGuild();
    await runSetup(client, guild, { teamSize: 3, preset: 'one', roles: false, feed: false });
    for (const size of [2, 3, 4]) expect(getDivisions(G, size).find(d => d.division === 'C')!.display_name).toBe('6mans');
    // Untouched divisions keep their names.
    expect(getDivisions(G, 3).find(d => d.division === 'B')!.display_name).toBe('Rank B');
    expect(withGuildTheme(G, () => getDivisionTier('C').name)).toBe('6mans');
    expect(withGuildTheme(G, () => getDivisionTier('B').name)).toBe('Rank B');
    expect(getDivisionTier('C').name).toBe('Rank C'); // outside any guild: the built-in name
  });

  it('re-running with a name renames the category, channel and role it made, and makes nothing new', async () => {
    // Vanilla's: first run happened before the name option existed, under "Rank C".
    const { guild, client, created, channels, roles } = fakeGuild();
    const { ensureGuildDefaults } = await import('../src/services/guildSetup');
    ensureGuildDefaults(G);
    for (const size of [2, 3, 4]) updateDivision(G, size, 'C', { display_name: 'Rank C' });
    invalidateDivisionNames(G);
    const cat = await guild.channels.create({ name: categoryName({ display_name: 'Rank C' }), type: ChannelType.GuildCategory });
    const chan = await guild.channels.create({ name: 'rank-c-3v3', type: ChannelType.GuildText, parent: cat.id });
    const role = await guild.roles.create({ name: 'Rank C' });
    updateDivision(G, 3, 'C', { queue_channel_id: chan.id, role_id: role.id });
    created.length = 0;

    const report = await runSetup(client, guild, { teamSize: 3, preset: 'one', roles: true, feed: false, name: 'Vanilla 6mans' });
    expect(created).toEqual([]);
    expect(report.created).toBe(0);
    expect(channels.get(cat.id)!.name).toBe('━━━━━  Vanilla 6mans  ━━━━━');
    expect(channels.get(chan.id)!.name).toBe('vanilla-6mans-3v3');
    expect(roles.get(role.id)!.name).toBe('Vanilla 6mans');
    expect(report.lines.filter(l => l.includes('renamed'))).toHaveLength(3);
    expect(withGuildTheme(G, () => getDivisionTier('C').name)).toBe('Vanilla 6mans');

    // And a third run with the same name is a no-op.
    const again = await runSetup(client, guild, { teamSize: 3, preset: 'one', roles: true, feed: false, name: 'Vanilla 6mans' });
    expect(again.lines.filter(l => l.includes('renamed'))).toHaveLength(0);
    expect(created).toEqual([]);
  });
});

describe('category naming and order', () => {
  it('recognises a plain "Rank B" category made by hand, and does not make a second one', async () => {
    const { guild, client, created, channels } = fakeGuild();
    await guild.channels.create({ name: 'Rank B', type: ChannelType.GuildCategory });
    await guild.channels.create({ name: 'rank c', type: ChannelType.GuildCategory });
    created.length = 0;
    await runSetup(client, guild, { teamSize: 3, preset: 'three', roles: false, feed: false });
    expect(created.filter(c => c.startsWith('category:'))).toEqual([`category:${categoryName({ display_name: 'Rank A' })}`]);
    expect([...channels.values()].filter(c => c.type === ChannelType.GuildCategory)).toHaveLength(3);
    expect(isCategoryFor('━━━━━  Rank S  ━━━━━', { display_name: 'Rank S' })).toBe(true);
    expect(isCategoryFor('Rank S', { display_name: 'Rank X' })).toBe(false);
  });

  it('puts the rank categories in S -> C order as one block, from where the block already starts', async () => {
    const { guild, client, channels, positions } = fakeGuild();
    await guild.channels.create({ name: 'General', type: ChannelType.GuildCategory }); // position 0, untouched
    await guild.channels.create({ name: 'Rank C', type: ChannelType.GuildCategory }); // 1: an old run left C on top
    await guild.channels.create({ name: 'Rank A', type: ChannelType.GuildCategory }); // 2
    await runSetup(client, guild, { teamSize: 3, preset: 'three', roles: false, feed: false });

    expect(positions).toHaveLength(1);
    const byName = (n: string) => [...channels.values()].find(c => c.type === ChannelType.GuildCategory && isCategoryFor(c.name, { display_name: n }))!;
    expect(byName('Rank A').position).toBe(1);
    expect(byName('Rank B').position).toBe(2);
    expect(byName('Rank C').position).toBe(3);
    expect([...channels.values()].find(c => c.name === 'General')!.position).toBe(0);
  });
});

describe('panel posting', () => {
  it('gives the bot access on the channels it makes, so a private category cannot hide the panel', async () => {
    const { guild, client, channels } = fakeGuild({ privateCategories: true });
    const report = await runSetup(client, guild, { teamSize: 2, preset: 'one', roles: false, feed: false });
    expect(report.warnings).toEqual([]);
    const c = getDivisions(G, 2).find(d => d.division === 'C')!;
    expect(getQueue(c.queue_channel_id!)!.message_id).toMatch(/^msg_/);
    const chan = channels.get(c.queue_channel_id!)!;
    expect(chan.permissionOverwrites.edited).toMatchObject({ id: 'bot_1', ViewChannel: true, SendMessages: true });
  });

  it('says so when the panel could not be posted, instead of reporting success', async () => {
    const { guild, client, channels } = fakeGuild();
    const { ensureGuildDefaults } = await import('../src/services/guildSetup');
    ensureGuildDefaults(G);
    // A pre-existing registered channel the bot has no access to (a category made private after the fact).
    const hidden = await guild.channels.create({ name: '6mans-3v3', type: ChannelType.GuildText });
    channels.get(hidden.id)!.sendFails = true;
    updateDivision(G, 3, 'C', { queue_channel_id: hidden.id });

    const report = await runSetup(client, guild, { teamSize: 3, preset: 'one', roles: false, feed: false });
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain(`<#${hidden.id}>`);
    expect(report.warnings[0]).toContain('View Channel');
    expect(getQueue(hidden.id)!.message_id).toBeUndefined();
  });
});

describe('missingBotPermissions', () => {
  it('lists what is missing, wants Manage Roles only when roles are requested, and trusts Administrator', () => {
    expect(missingBotPermissions(fakeGuild({ perms: [PermissionFlagsBits.ViewChannel] }).guild, false)).toEqual(['Manage Channels', 'Send Messages', 'Attach Files']);
    expect(missingBotPermissions(fakeGuild({ perms: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] }).guild, true)).toEqual(['Manage Roles']);
    expect(missingBotPermissions(fakeGuild({ admin: true, perms: [] }).guild, true)).toEqual([]);
  });
});

describe('/setup command shape', () => {
  it('is registered, admin-gated, and defaults to one ladder', () => {
    expect(commands.map(c => c.data.name)).toContain('setup');
    const json = setupCommand.data.toJSON();
    expect(json.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
    const divisions = json.options?.find(o => o.name === 'divisions') as any;
    expect(divisions.choices.map((c: any) => c.value)).toEqual(Object.keys(PRESET_DIVISIONS));
    expect(queueChannelName({ display_name: 'Rank S' }, 4)).toBe('rank-s-4v4');
  });
});
