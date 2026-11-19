import { Client } from 'discord.js';
import { Player } from '../database/queries';
import { generateQueuePanelImage } from '../services/queueImage';
import { generateMatchResultImage } from '../services/resultImage';

/**
 * Two cards with fixed sample players, drawn under whatever palette is current, so an
 * admin can see a theme before the server does. The queue panel and the result card
 * between them use nearly every public token.
 */

const sample = (name: string, mmr: number, division: string, streak = 0): Player =>
  ({
    guild_id: 'preview', discord_id: `preview_${name}`, username: name, created_at: '',
    team_size: 3, division, mmr, wins: 12, losses: 9, streak, placed: 1,
  }) as Player;

export async function renderThemePreview(
  client: Client,
  division: string
): Promise<{ queue: Buffer; result: Buffer }> {
  const roster = [
    sample('Tom', 1327, division, 3), sample('ana', 1312, division), sample('kai_kickoff', 1292, division),
    sample('demo_dani', 1288, division), sample('fin', 1270, division, 5), sample('boost_ben', 1255, division),
  ];
  const blue = roster.slice(0, 3);
  const orange = roster.slice(3);
  const result = (team: Player[], delta: number) =>
    team.map(player => ({ player, delta, newMmr: player.mmr + delta, previousStreak: player.streak }));

  return {
    queue: await generateQueuePanelImage(client, roster.slice(0, 4), 3, division),
    result: await generateMatchResultImage(client, 42, 'BLUE', result(blue, 14), result(orange, -14), '26m'),
  };
}
