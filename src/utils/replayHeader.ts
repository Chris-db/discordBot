/**
 * Reads the header of a Rocket League `.replay` file.
 *
 * A replay is a header of Unreal properties followed by the network stream. The header
 * alone -- the first few kilobytes -- carries the final score, the winning team, the
 * start time and one entry per player with name, team, platform id and stat line. That
 * is everything a disputed report needs, so the network stream is never touched.
 *
 * Format, as documented by the community parsers (boxcars, rattletrap):
 *   u32 header size, u32 crc, u32 major, u32 minor, [u32 net version],
 *   string game type, then a property dictionary terminated by a "None" name.
 * Strings are i32 length-prefixed: positive means Windows-1252 bytes, negative means
 * UTF-16LE with -length code units; both include a trailing NUL. Properties omitted from
 * the header are at their default, so a missing Team0Score is a nil.
 */

export interface ReplayPlayer {
  name: string;
  /** 0 is Blue, 1 is Orange -- Rocket League's own numbering. */
  team: 0 | 1;
  score: number;
  goals: number;
  assists: number;
  saves: number;
  shots: number;
  bot: boolean;
  platform?: string;
  /** Steam id / PSN id / Epic account id, as the platform reports it. */
  onlineId?: string;
}

export interface ReplayHeader {
  replayId?: string;
  /** "Private", "Online", "Offline", "Season"… as the game labels it. */
  matchType?: string;
  mapName?: string;
  /** Local time on the recording PC, as the game wrote it: "2026-09-07 20-59-32". */
  date?: string;
  /** Unix seconds, when the header carries it (newer replays). */
  matchStartEpoch?: number;
  teamSize: number;
  blueScore: number;
  orangeScore: number;
  winner: 'BLUE' | 'ORANGE' | 'DRAW';
  /** Whoever pressed Save Replay. */
  recordedBy?: string;
  totalSecondsPlayed?: number;
  players: ReplayPlayer[];
}

type PropertyValue = number | bigint | string | boolean | PropertyDict[] | PropertyDict | null;
interface PropertyDict {
  [name: string]: PropertyValue;
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new Error(`Replay header truncated at byte ${this.offset}`);
    }
  }

  u8(): number { this.need(1); return this.buf[this.offset++]; }
  i32(): number { this.need(4); const v = this.buf.readInt32LE(this.offset); this.offset += 4; return v; }
  u32(): number { this.need(4); const v = this.buf.readUInt32LE(this.offset); this.offset += 4; return v; }
  u64(): bigint { this.need(8); const v = this.buf.readBigUInt64LE(this.offset); this.offset += 8; return v; }
  f32(): number { this.need(4); const v = this.buf.readFloatLE(this.offset); this.offset += 4; return v; }

  string(): string {
    const len = this.i32();
    if (len === 0) return '';
    if (len > 0) {
      this.need(len);
      const s = this.buf.toString('latin1', this.offset, this.offset + len - 1);
      this.offset += len;
      return s;
    }
    const bytes = -len * 2;
    this.need(bytes);
    const s = this.buf.toString('utf16le', this.offset, this.offset + bytes - 2);
    this.offset += bytes;
    return s;
  }
}

function readProperty(r: Reader, type: string): PropertyValue {
  switch (type) {
    case 'IntProperty': return r.i32();
    case 'FloatProperty': return r.f32();
    case 'BoolProperty': return r.u8() !== 0;
    case 'QWordProperty': return r.u64();
    case 'StrProperty':
    case 'NameProperty': return r.string();
    case 'ByteProperty': {
      // An enum: the enum's name, then the value. Old replays wrote the platform as a
      // single string with no value after it. A "None" enum name (the PSN id padding
      // fields Term / Dummy) is followed by one raw byte rather than a string.
      const key = r.string();
      if (key.startsWith('OnlinePlatform_')) return key;
      if (key === 'None') return r.u8();
      return r.string();
    }
    case 'ArrayProperty': {
      const count = r.u32();
      const items: PropertyDict[] = [];
      for (let i = 0; i < count; i++) items.push(readDict(r));
      return items;
    }
    case 'StructProperty': {
      r.string(); // struct type name, e.g. UniqueNetId
      return readDict(r);
    }
    default:
      throw new Error(`Unknown replay property type "${type}"`);
  }
}

function readDict(r: Reader): PropertyDict {
  const dict: PropertyDict = {};
  for (;;) {
    const name = r.string();
    if (name === 'None') return dict;
    const type = r.string();
    r.u64(); // size in bytes -- not needed when every type is understood
    dict[name] = readProperty(r, type);
  }
}

const num = (v: PropertyValue | undefined, fallback = 0): number =>
  typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : fallback;
const str = (v: PropertyValue | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

function readOnlineId(entry: PropertyDict): string | undefined {
  const direct = entry.OnlineID;
  if (typeof direct === 'bigint' && direct !== 0n) return direct.toString();
  const id = entry.PlayerID;
  if (id && typeof id === 'object' && !Array.isArray(id)) {
    const epic = str(id.EpicAccountId);
    if (epic) return epic;
    const uid = id.Uid;
    if (typeof uid === 'bigint' && uid !== 0n) return uid.toString();
  }
  return undefined;
}

/** Parses the header. Throws on anything that is not a Rocket League replay. */
export function parseReplayHeader(buffer: Buffer): ReplayHeader {
  const r = new Reader(buffer);
  r.u32(); // header size
  r.u32(); // crc
  const major = r.u32();
  const minor = r.u32();
  if (major >= 868 && minor >= 18) r.u32(); // net version
  const gameType = r.string();
  if (!gameType.startsWith('TAGame.Replay_')) {
    throw new Error(`Not a Rocket League replay (game type "${gameType}")`);
  }
  const props = readDict(r);

  const stats = Array.isArray(props.PlayerStats) ? props.PlayerStats : [];
  const players: ReplayPlayer[] = stats.map(entry => ({
    name: str(entry.Name) ?? '?',
    team: num(entry.Team) === 1 ? 1 : 0,
    score: num(entry.Score),
    goals: num(entry.Goals),
    assists: num(entry.Assists),
    saves: num(entry.Saves),
    shots: num(entry.Shots),
    bot: entry.bBot === true,
    platform: str(entry.Platform)?.replace(/^OnlinePlatform_/, ''),
    onlineId: readOnlineId(entry),
  }));

  const blueScore = num(props.Team0Score);
  const orangeScore = num(props.Team1Score);
  // The score decides. WinningTeam only exists in newer replays and only settles a
  // level score, which is a forfeit -- there its presence with value 0 means Blue, so it
  // has to be told apart from the property being absent (a genuine draw, or an old file).
  let winner: ReplayHeader['winner'];
  if (blueScore !== orangeScore) {
    winner = blueScore > orangeScore ? 'BLUE' : 'ORANGE';
  } else if ('WinningTeam' in props) {
    winner = num(props.WinningTeam) === 1 ? 'ORANGE' : 'BLUE';
  } else {
    winner = 'DRAW';
  }

  const epoch = props.MatchStartEpoch;
  return {
    replayId: str(props.Id),
    matchType: str(props.MatchType),
    mapName: str(props.MapName),
    date: str(props.Date),
    matchStartEpoch: typeof epoch === 'bigint' && epoch > 0n ? Number(epoch) : undefined,
    teamSize: num(props.TeamSize, players.length ? Math.ceil(players.length / 2) : 0),
    blueScore,
    orangeScore,
    winner,
    recordedBy: str(props.PlayerName),
    totalSecondsPlayed: typeof props.TotalSecondsPlayed === 'number' ? props.TotalSecondsPlayed : undefined,
    players,
  };
}
