import { describe, it, expect, beforeEach } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import db from '../src/database/db';
import { getDivisions, getQueue, updateDivision } from '../src/database/queries';
import { runSetup, missingBotPermissions, queueChannelName, categoryName, isCategoryFor, PRESET_DIVISIONS } from '../src/services/setupService';
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
  permissionOverwrites: { set: (o: any[]) => Promise<void>; last?: any[] };
}

function fakeGuild(opts: { admin?: boolean; perms?: bigint[] } = {}) {
  let nextId = 1;
  const channels = new Map<string, FakeChannel>();
  const roles = new Map<string, { id: string; name: string }>();
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
        const r = { id: `role_${nextId++}`, name };
        roles.set(r.id, r);
        created.push(`role:${name}`);
        return r;
      },
    },
    channels: {
      cache: cacheOf(channels),
      create: async ({ name, type, parent }: { name: string; type: ChannelType; parent?: string }) => {
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
          },
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
  return { guild: guild as any, created, channels, roles, positions };
}

const client = {
  user: { id: 'bot_1' },
  channels: { fetch: async () => null },
  guilds: { fetch: async () => null },
  users: { fetch: async () => null },
} as any;

beforeEach(() => {
  db.exec(
    `DELETE FROM active_queues WHERE guild_id = '${G}'; DELETE FROM guild_divisions WHERE guild_id = '${G}';
     DELETE FROM guild_config WHERE guild_id = '${G}'; DELETE FROM seasons WHERE guild_id = '${G}';`
  );
});

describe('runSetup', () => {
  it('one ladder: a category, a registered queue channel with a queue row, and the feed', async () => {
    const { guild, created } = fakeGuild();
    const report = await runSetup(client, guild, { teamSize: 3, preset: 'one', roles: false, feed: true });

    expect(created).toEqual([`category:${categoryName({ display_name: 'Rank C' })}`, 'text:rank-c-3v3', 'text:active-matches']);
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
    const { guild, created } = fakeGuild();
    await runSetup(client, guild, { teamSize: 3, preset: 'three', roles: true, feed: true });
    const firstCount = created.length;
    expect(firstCount).toBe(3 * 3 + 1); // role + category + channel per division, plus feed

    const again = await runSetup(client, guild, { teamSize: 3, preset: 'three', roles: true, feed: true });
    expect(created.length).toBe(firstCount);
    expect(again.created).toBe(0);
    expect(again.reused).toBe(firstCount);
  });

  it('all five, with roles: each category is locked to its role and the role is stored', async () => {
    const { guild, created, channels, roles } = fakeGuild();
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
    const { guild, created, channels } = fakeGuild();
    const custom = await guild.channels.create({ name: 'my-own-queue', type: ChannelType.GuildText });
    created.length = 0;
    const { ensureGuildDefaults } = await import('../src/services/guildSetup');
    ensureGuildDefaults(G);
    updateDivision(G, 3, 'C', { queue_channel_id: custom.id });

    const report = await runSetup(client, guild, { teamSize: 3, preset: 'one', roles: false, feed: false });
    expect(created).toEqual([`category:${categoryName({ display_name: 'Rank C' })}`]);
    expect(report.lines.join('\n')).toContain(`<#${custom.id}> (already registered)`);
    expect(getDivisions(G, 3).find(d => d.division === 'C')!.queue_channel_id).toBe(custom.id);
    expect(channels.size).toBe(2);
  });

  it('sizes are independent: 3v3 then 2v2 gives each its own channel and ladder', async () => {
    const { guild, created } = fakeGuild();
    await runSetup(client, guild, { teamSize: 3, preset: 'one', roles: false, feed: false });
    await runSetup(client, guild, { teamSize: 2, preset: 'one', roles: false, feed: false });
    expect(created).toEqual([`category:${categoryName({ display_name: 'Rank C' })}`, 'text:rank-c-3v3', 'text:rank-c-2v2']);
    const c3 = getDivisions(G, 3).find(d => d.division === 'C')!;
    const c2 = getDivisions(G, 2).find(d => d.division === 'C')!;
    expect(c3.queue_channel_id).not.toBe(c2.queue_channel_id);
    expect(getQueue(c2.queue_channel_id!)!.team_size).toBe(2);
  });

  it('a role that cannot lock its category is a warning, not a failure', async () => {
    const { guild, channels } = fakeGuild();
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

describe('category naming and order', () => {
  it('recognises a plain "Rank B" category made by hand, and does not make a second one', async () => {
    const { guild, created, channels } = fakeGuild();
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
    const { guild, channels, positions } = fakeGuild();
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
