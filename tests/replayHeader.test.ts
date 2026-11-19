import { describe, it, expect } from 'vitest';
import { parseReplayHeader } from '../src/utils/replayHeader';

/**
 * A tiny encoder for the header format, so the fixture is built here rather than
 * committed as a real replay (which would carry friends' platform ids into a public
 * repo). The parser was validated against 260 real files on 2026-09-11 -- see the
 * commit message -- this just pins the shape it depends on.
 */
type Prop =
  | ['IntProperty', number]
  | ['FloatProperty', number]
  | ['BoolProperty', boolean]
  | ['QWordProperty', bigint]
  | ['StrProperty' | 'NameProperty', string]
  | ['ByteProperty', string, string | number | null]
  | ['ArrayProperty', Array<Record<string, Prop>>]
  | ['StructProperty', string, Record<string, Prop>];

const str = (s: string, wide = false): Buffer => {
  if (s === '') return Buffer.from([0, 0, 0, 0]);
  if (!wide) {
    const body = Buffer.from(s + '\0', 'latin1');
    return Buffer.concat([u32(body.length), body]);
  }
  const body = Buffer.from(s + '\0', 'utf16le');
  return Buffer.concat([i32(-(body.length / 2)), body]);
};
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const f32 = (n: number) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

function value(p: Prop): Buffer {
  switch (p[0]) {
    case 'IntProperty': return i32(p[1]);
    case 'FloatProperty': return f32(p[1]);
    case 'BoolProperty': return Buffer.from([p[1] ? 1 : 0]);
    case 'QWordProperty': return u64(p[1]);
    case 'StrProperty':
    case 'NameProperty': return str(p[1], /[^\x00-\xff]/.test(p[1]));
    case 'ByteProperty':
      return Buffer.concat([
        str(p[1]),
        p[2] === null ? Buffer.alloc(0) : typeof p[2] === 'number' ? Buffer.from([p[2]]) : str(p[2]),
      ]);
    case 'ArrayProperty': return Buffer.concat([u32(p[1].length), ...p[1].map(dict)]);
    case 'StructProperty': return Buffer.concat([str(p[1]), dict(p[2])]);
  }
}

function dict(props: Record<string, Prop>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, p] of Object.entries(props)) {
    const v = value(p);
    parts.push(str(name), str(p[0]), u32(v.length), u32(0), v);
  }
  parts.push(str('None'));
  return Buffer.concat(parts);
}

function replay(props: Record<string, Prop>): Buffer {
  const body = Buffer.concat([u32(868), u32(32), u32(10), str('TAGame.Replay_Soccar_TA'), dict(props)]);
  return Buffer.concat([u32(body.length), u32(0), body, Buffer.from('network stream would follow')]);
}

function player(name: string, team: 0 | 1, goals: number, extra: Record<string, Prop> = {}): Record<string, Prop> {
  return {
    Name: ['StrProperty', name],
    Platform: ['ByteProperty', 'OnlinePlatform', 'OnlinePlatform_Epic'],
    OnlineID: ['QWordProperty', 0n],
    Team: ['IntProperty', team],
    Score: ['IntProperty', 100 * goals + 50],
    Goals: ['IntProperty', goals],
    Assists: ['IntProperty', 0],
    Saves: ['IntProperty', 1],
    Shots: ['IntProperty', goals + 1],
    bBot: ['BoolProperty', false],
    PlayerID: ['StructProperty', 'UniqueNetId', {
      Uid: ['QWordProperty', 0n],
      NpId: ['StructProperty', 'SceNpId', {
        Handle: ['StructProperty', 'SceNpOnlineId', {
          Data: ['QWordProperty', 0n],
          Term: ['ByteProperty', 'None', 0],
          Dummy: ['ByteProperty', 'None', 0],
        }],
        Opt: ['QWordProperty', 0n],
      }],
      EpicAccountId: ['StrProperty', `epic_${name}`],
      Platform: ['ByteProperty', 'OnlinePlatform', 'OnlinePlatform_Epic'],
    }],
    ...extra,
  };
}

const threeVthree = () =>
  replay({
    TeamSize: ['IntProperty', 3],
    Team0Score: ['IntProperty', 3],
    Team1Score: ['IntProperty', 1],
    TotalSecondsPlayed: ['FloatProperty', 312.5],
    MatchStartEpoch: ['QWordProperty', 1788796031n],
    WinningTeam: ['IntProperty', 0],
    PlayerStats: ['ArrayProperty', [
      player('Tom', 0, 2), player('aerial_ana', 0, 1), player('Jérôme', 0, 0),
      player('kai_kickoff', 1, 1), player('demo_dani', 1, 0), player('fin', 1, 0),
    ]],
    Date: ['StrProperty', '2026-09-07 20-59-32'],
    MatchType: ['NameProperty', 'Private'],
    PlayerName: ['StrProperty', 'Tom'],
    MapName: ['NameProperty', 'EuroStadium_P'],
    Id: ['StrProperty', 'ABC123'],
  });

describe('parseReplayHeader', () => {
  it('reads score, winner, players and ids from the header alone', () => {
    const h = parseReplayHeader(threeVthree());

    expect(h.teamSize).toBe(3);
    expect(h.blueScore).toBe(3);
    expect(h.orangeScore).toBe(1);
    expect(h.winner).toBe('BLUE');
    expect(h.matchType).toBe('Private');
    expect(h.matchStartEpoch).toBe(1788796031);
    expect(h.recordedBy).toBe('Tom');
    expect(h.players.map(p => `${p.name}:${p.team}:${p.goals}`)).toEqual([
      'Tom:0:2', 'aerial_ana:0:1', 'Jérôme:0:0', 'kai_kickoff:1:1', 'demo_dani:1:0', 'fin:1:0',
    ]);
    // Epic ids come from the nested PlayerID struct when OnlineID is zero.
    expect(h.players[0].onlineId).toBe('epic_Tom');
    expect(h.players[0].platform).toBe('Epic');
  });

  it('treats a missing score property as zero and decides the winner from the score', () => {
    const h = parseReplayHeader(
      replay({
        TeamSize: ['IntProperty', 2],
        Team1Score: ['IntProperty', 2],
        PlayerStats: ['ArrayProperty', [player('a', 0, 0), player('b', 1, 2)]],
      })
    );
    expect(h.blueScore).toBe(0);
    expect(h.orangeScore).toBe(2);
    expect(h.winner).toBe('ORANGE');
  });

  it('uses WinningTeam only to settle a level score, and tells value 0 from absent', () => {
    const base = { TeamSize: ['IntProperty', 3] as Prop, PlayerStats: ['ArrayProperty', []] as Prop };
    expect(parseReplayHeader(replay(base)).winner).toBe('DRAW');
    expect(parseReplayHeader(replay({ ...base, WinningTeam: ['IntProperty', 0] })).winner).toBe('BLUE');
    expect(parseReplayHeader(replay({ ...base, WinningTeam: ['IntProperty', 1] })).winner).toBe('ORANGE');
    // A score beats a contradictory WinningTeam (old files never carry it anyway).
    expect(
      parseReplayHeader(replay({ ...base, Team0Score: ['IntProperty', 1], WinningTeam: ['IntProperty', 1] })).winner
    ).toBe('BLUE');
  });

  it('prefers a non-zero OnlineID (Steam / PSN) over the Epic account id', () => {
    const h = parseReplayHeader(
      replay({
        PlayerStats: ['ArrayProperty', [player('steamer', 0, 0, { OnlineID: ['QWordProperty', 76561198000000001n] })]],
      })
    );
    expect(h.players[0].onlineId).toBe('76561198000000001');
  });

  it('refuses a file that is not a replay', () => {
    expect(() => parseReplayHeader(Buffer.from('%PDF-1.4 definitely not a replay, padded out'))).toThrow();
    expect(() => parseReplayHeader(Buffer.alloc(3))).toThrow(/truncated/);
  });
});
