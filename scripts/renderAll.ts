/**
 * Renders every card the bot can draw, with fixed sample data, into a directory.
 *
 *   DB_PATH=/tmp/x.sqlite npx ts-node scripts/renderAll.ts out/
 *
 * Two uses: look at the PNGs after touching any image code (two real bugs have only
 * ever been caught by looking), and diff two runs byte-for-byte to prove a refactor
 * changed nothing. Avatars are never fetched, so the output is deterministic.
 */
import fs from 'fs';
import path from 'path';
import { registerFonts } from '../src/utils/fonts';
import db from '../src/database/db';
import { initializeDatabase } from '../src/database/schema';
import { seedGuildDefaults } from '../src/database/migrations';
import { Player, Match } from '../src/database/queries';
import { generateQueuePanelImage } from '../src/services/queueImage';
import { generateReadyCheckImage } from '../src/services/readyCheckImage';
import { generateModeVoteImage } from '../src/services/voteImage';
import { generateCaptainsDraftImage } from '../src/services/draftImage';
import { generateMatchVsImage } from '../src/services/matchImage';
import { generateMatchResultImage } from '../src/services/resultImage';
import { generateGambleResultImage } from '../src/services/gambleImage';
import { generateLeaderboardImage } from '../src/services/leaderboardImage';
import { generatePlayerProfileImage } from '../src/services/profileImage';
import { ProfileCardData, MmrBar, BestTeammate } from '../src/services/profileCard';
import { generateMatchHistoryImage } from '../src/services/historyImage';

registerFonts();
// The result and gamble cards read division thresholds, so the scratch DB needs a guild.
initializeDatabase();
seedGuildDefaults(db, 'g');
const client = { users: { fetch: async () => null } } as any;

const p = (name: string, mmr: number, division: string, extra: Partial<Player> = {}): Player =>
  ({
    guild_id: 'g', discord_id: `id_${name}`, username: name, created_at: '2026-08-01 10:00:00',
    team_size: 3, division, mmr, wins: 12, losses: 9, streak: 0, placed: 1, ...extra,
  }) as Player;

const roster = [
  p('zephyerrl', 1327, 'B', { streak: 3 }), p('ravi_rl1', 1312, 'B'), p('a8chi', 1292, 'B', { streak: -2 }),
  p('wilxnt', 1288, 'B'), p('goldninja_rl', 1270, 'B', { streak: 5 }), p('josho', 1255, 'B'),
];
const blue = roster.slice(0, 3);
const orange = roster.slice(3);
const result = (team: Player[], delta: number) =>
  team.map(player => ({ player, delta, newMmr: player.mmr + delta, previousStreak: player.streak }));

const match = (id: number, winner: 'BLUE' | 'ORANGE', extra: Partial<Match> = {}): Match =>
  ({
    match_id: id, match_number: id, guild_id: 'g', channel_id: 'c', team_size: 3, state: 'COMPLETED', winner,
    blue_team: blue.map(x => x.discord_id), orange_team: orange.map(x => x.discord_id),
    rl_name: 'RL42', rl_pass: '317', created_at: '2026-09-10 18:00:00',
    started_at: '2026-09-10T18:05:00.000Z', completed_at: '2026-09-10T18:31:00.000Z',
    report_status: { blueVotes: [], orangeVotes: [], cancelVotes: [] }, vote_counts: {},
    division: 'B', ...extra,
  }) as Match;

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) throw new Error('usage: renderAll.ts <out dir>');
  fs.mkdirSync(out, { recursive: true });
  const write = async (name: string, png: Promise<Buffer>) => {
    fs.writeFileSync(path.join(out, `${name}.png`), await png);
  };

  await write('queue_B_partial', generateQueuePanelImage(client, roster.slice(0, 3), 3, 'B'));
  await write('queue_S_full', generateQueuePanelImage(client, roster, 3, 'S'));
  await write('queue_2v2_unregistered', generateQueuePanelImage(client, roster.slice(0, 1), 2));
  await write('ready_check', generateReadyCheckImage(client, roster, roster.slice(0, 4).map(x => x.discord_id), 3));
  await write('mode_vote', generateModeVoteImage(roster, { captains: 2, balanced: 1, random: 0 }, 4, 3));
  await write('draft', generateCaptainsDraftImage(client, blue[0], orange[0], [blue[0], blue[1]], [orange[0]], [blue[2], orange[1], orange[2]], 'ORANGE', 2, 3));
  await write('match_vs', generateMatchVsImage(client, 42, blue, orange));
  await write('result', generateMatchResultImage(client, 42, 'BLUE', result(blue, 14), result(orange, -14), '26m'));
  await write('gamble_doubled', generateGambleResultImage(client, 42, 'BLUE', 'DOUBLED', result(blue, 28), result(orange, -28)));
  await write('gamble_inverted', generateGambleResultImage(client, 42, 'ORANGE', 'INVERTED', result(blue, -14), result(orange, 14)));
  await write('leaderboard', generateLeaderboardImage(client, [...roster, p('sudoroso', 1201, 'B'), p('Cometteninho', 1190, 'B')], 1, 3));
  // The profile card's bar and fourth stat come from profileCard.ts; these are the four
  // shapes it can take, drawn from fixtures rather than the database.
  const profile = (player: Player, rank: number, bar: MmrBar, bestTeammate?: BestTeammate): ProfileCardData =>
    ({ player, rank, totalPlayers: 8, bar, bestTeammate });
  await write('profile_ranked', generatePlayerProfileImage(client, profile(
    roster[0], 1, { from: 1300, to: 1400, progress: 0.27, label: 'Promotes to Rank A at 1400' },
    { discord_id: 'id_wilxnt', username: 'wilxnt', wins: 7, games: 9 }
  )));
  await write('profile_one_ladder', generatePlayerProfileImage(client, profile(
    p('zephyerrl', 1016, 'C', { wins: 1, losses: 1, streak: -1 }), 2, { from: 1000, to: 1180, progress: 0.09, label: 'Ladder top: 1180 (ravi_rl1)' },
    { discord_id: 'id_a8chi', username: 'a8chi', wins: 1, games: 2 }
  )));
  await write('profile_on_top', generatePlayerProfileImage(client, profile(
    p('ravi_rl1', 1180, 'C', { wins: 9, losses: 3, streak: 4 }), 1, { from: 1000, to: 1180, progress: 1, label: "You're on top 👑" },
    { discord_id: 'id_x', username: 'averyveryverylongdiscordname', wins: 5, games: 6 }
  )));
  await write('profile_new', generatePlayerProfileImage(client, profile(
    p('josho', 1000, 'C', { wins: 0, losses: 0, streak: 0 }), 0, { from: 1000, to: 1200, progress: 0, label: 'Promotes to Rank B at 1200' }
  )));
  await write('history', generateMatchHistoryImage(client, [match(42, 'BLUE'), match(41, 'ORANGE'), match(40, 'BLUE', { winner: 'NONE', state: 'CANCELLED' })], undefined));
  console.log(`rendered ${fs.readdirSync(out).length} cards to ${out}`);
}

main().catch(err => { console.error(err); process.exit(1); });
