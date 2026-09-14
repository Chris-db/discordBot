import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import { updateDivision } from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import { syncDivisionRoles } from '../src/services/divisionRoles';
import { PlayerSeasonResult } from '../src/services/seasonService';

const G = 'guild_roles_test';
const ROLE = { C: 'role_c', B: 'role_b', A: 'role_a' };

/** A guild whose members hold the roles they are seeded with and record every change. */
function fakeGuild(members: Record<string, string[]>) {
  const added: Record<string, string[]> = {};
  const removed: Record<string, string[]> = {};
  const client = {
    guilds: {
      fetch: async () => ({
        members: {
          fetch: async (id: string) => {
            if (!(id in members)) throw new Error('Unknown Member');
            const held = new Set(members[id]);
            return {
              roles: {
                cache: { has: (r: string) => held.has(r) },
                add: async (ids: string[]) => { (added[id] ??= []).push(...ids); },
                remove: async (ids: string[]) => { (removed[id] ??= []).push(...ids); },
              },
            };
          },
        },
      }),
    },
  } as any;
  return { client, added, removed };
}

function move(
  discord_id: string,
  teamSize: number,
  fromDivision: string,
  toDivision: string
): PlayerSeasonResult {
  const outcome = fromDivision === toDivision ? 'STAYED' : fromDivision < toDivision ? 'RELEGATED' : 'PROMOTED';
  return { discord_id, username: discord_id, teamSize, fromDivision, toDivision, finalMmr: 0, newMmr: 0, finalRank: 1, outcome };
}

describe('division role sync after a season reset', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM guild_divisions WHERE guild_id = '${G}';`);
    seedGuildDefaults(db, G);
    // /setup shares one role per division name across sizes.
    for (const size of [2, 3]) {
      updateDivision(G, size, 'C', { role_id: ROLE.C });
      updateDivision(G, size, 'B', { role_id: ROLE.B });
      updateDivision(G, size, 'A', { role_id: ROLE.A });
    }
  });

  it('swaps a promoted player onto the new role', async () => {
    const { client, added, removed } = fakeGuild({ p1: [ROLE.C] });

    const report = await syncDivisionRoles(client, G, [move('p1', 3, 'C', 'B')]);

    expect(report).toEqual({ moved: 1, skipped: 0 });
    expect(added.p1).toEqual([ROLE.B]);
    expect(removed.p1).toEqual([ROLE.C]);
  });

  it('keeps a shared role the player still needs on another size', async () => {
    const { client, added, removed } = fakeGuild({ p1: [ROLE.C] });

    const report = await syncDivisionRoles(client, G, [
      move('p1', 3, 'C', 'B'), // promoted in 3v3
      move('p1', 2, 'C', 'C'), // still Rank C in 2v2
    ]);

    expect(report.moved).toBe(1);
    expect(added.p1).toEqual([ROLE.B]);
    expect(removed.p1).toBeUndefined();
  });

  it('leaves players who stayed alone', async () => {
    const { client, added, removed } = fakeGuild({ p1: [ROLE.B] });

    const report = await syncDivisionRoles(client, G, [move('p1', 3, 'B', 'B')]);

    expect(report).toEqual({ moved: 0, skipped: 0 });
    expect(added).toEqual({});
    expect(removed).toEqual({});
  });

  it('does not re-add a role the member already holds', async () => {
    const { client, added, removed } = fakeGuild({ p1: [ROLE.C, ROLE.B] });

    await syncDivisionRoles(client, G, [move('p1', 3, 'C', 'B')]);

    expect(added.p1).toBeUndefined();
    expect(removed.p1).toEqual([ROLE.C]);
  });

  it('skips a member who has left the server and carries on', async () => {
    const { client, added } = fakeGuild({ p2: [ROLE.C] });

    const report = await syncDivisionRoles(client, G, [move('gone', 3, 'C', 'B'), move('p2', 3, 'C', 'B')]);

    expect(report).toEqual({ moved: 1, skipped: 1 });
    expect(added.p2).toEqual([ROLE.B]);
  });

  it('skips silently when the divisions have no roles', async () => {
    for (const size of [2, 3]) {
      for (const d of ['C', 'B', 'A']) updateDivision(G, size, d, { role_id: null as any });
    }
    const { client, added, removed } = fakeGuild({ p1: [] });

    const report = await syncDivisionRoles(client, G, [move('p1', 3, 'C', 'B')]);

    expect(report).toEqual({ moved: 0, skipped: 1 });
    expect(added).toEqual({});
    expect(removed).toEqual({});
  });
});
