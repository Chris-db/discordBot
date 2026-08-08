import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { Player } from '../database/queries';
import { getDivisionTier } from './mmrService';
import { getCachedAvatarImage } from '../utils/avatarCache';

/**
 * Generates an 880x420 Captains Draft Visual Scoreboard.
 * Displays Blue Team on the left, Orange Team on the right, and the Available Draft Pool in the center.
 */
export async function generateCaptainsDraftImage(
  client: Client,
  blueCaptain: Player,
  orangeCaptain: Player,
  blueTeam: Player[],
  orangeTeam: Player[],
  remaining: Player[],
  turn: 'BLUE' | 'ORANGE',
  pickNumber: number
): Promise<Buffer> {
  const width = 880;
  const height = 420;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Dark background
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, '#0f172a');
  bgGradient.addColorStop(1, '#1e293b');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Top accent bar by current turn
  const turnColor = turn === 'BLUE' ? '#00b0ff' : '#ff9100';
  ctx.fillStyle = turnColor;
  ctx.fillRect(0, 0, width, 5);

  // 2. Title & Turn Header
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText('👑 CAPTAINS 1-2-1 DRAFT IN PROGRESS', width / 2, 45);

  ctx.font = 'bold 16px sans-serif';
  ctx.fillStyle = turnColor;
  const captainName = turn === 'BLUE' ? blueCaptain.username : orangeCaptain.username;
  ctx.fillText(`CURRENT TURN: ${turn === 'BLUE' ? '🔵 BLUE' : '🟠 ORANGE'} CAPTAIN (${captainName})  •  PICK #${pickNumber}`, width / 2, 75);

  // 3. Helper to draw a player card
  const drawPlayerCard = async (
    player: Player,
    x: number,
    y: number,
    w: number,
    h: number,
    borderColor: string,
    label?: string
  ) => {
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);

    // Avatar
    const radius = 20;
    const ax = x + 30;
    const ay = y + h / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax, ay, radius, 0, Math.PI * 2);
    ctx.clip();

    try {
      const img = await getCachedAvatarImage(client, player.discord_id, 128);
      if (img) {
        ctx.drawImage(img, ax - radius, ay - radius, radius * 2, radius * 2);
      } else {
        throw new Error('Avatar fallback');
      }
    } catch {
      ctx.fillStyle = '#334155';
      ctx.fillRect(ax - radius, ay - radius, radius * 2, radius * 2);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(player.username.charAt(0).toUpperCase() || '?', ax, ay + 5);
    }
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 16px sans-serif';
    const shortName = player.username.length > 10 ? player.username.substring(0, 9) + '…' : player.username;
    ctx.fillText(shortName, x + 60, y + 26);

    ctx.font = '600 13px sans-serif';
    ctx.fillStyle = '#94a3b8';
    const tier = getDivisionTier(player.division);
    ctx.fillText(`${player.mmr} MMR (${tier.name})`, x + 60, y + 46);

    if (label) {
      ctx.textAlign = 'right';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillStyle = borderColor;
      ctx.fillText(label, x + w - 10, y + 20);
    }
  };

  // 4. Left Column: Blue Team (x=30, w=250)
  ctx.textAlign = 'left';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillStyle = '#00b0ff';
  ctx.fillText('🔵 TEAM BLUE', 30, 115);

  const fullBlue = [blueCaptain, ...blueTeam.filter(p => p.discord_id !== blueCaptain.discord_id)];
  for (let i = 0; i < 3; i++) {
    const p = fullBlue[i];
    const cardY = 130 + i * 85;
    if (p) {
      await drawPlayerCard(p, 30, cardY, 250, 70, '#00b0ff', i === 0 ? '👑 CAPTAIN' : undefined);
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(30, cardY, 250, 70);
      ctx.strokeStyle = '#334155';
      ctx.strokeRect(30, cardY, 250, 70);
      ctx.textAlign = 'center';
      ctx.font = '600 14px sans-serif';
      ctx.fillStyle = '#475569';
      ctx.fillText('[ EMPTY SLOT ]', 30 + 125, cardY + 40);
    }
  }

  // 5. Right Column: Orange Team (x=600, w=250)
  ctx.textAlign = 'left';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillStyle = '#ff9100';
  ctx.fillText('🟠 TEAM ORANGE', 600, 115);

  const fullOrange = [orangeCaptain, ...orangeTeam.filter(p => p.discord_id !== orangeCaptain.discord_id)];
  for (let i = 0; i < 3; i++) {
    const p = fullOrange[i];
    const cardY = 130 + i * 85;
    if (p) {
      await drawPlayerCard(p, 600, cardY, 250, 70, '#ff9100', i === 0 ? '👑 CAPTAIN' : undefined);
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(600, cardY, 250, 70);
      ctx.strokeStyle = '#334155';
      ctx.strokeRect(600, cardY, 250, 70);
      ctx.textAlign = 'center';
      ctx.font = '600 14px sans-serif';
      ctx.fillStyle = '#475569';
      ctx.fillText('[ EMPTY SLOT ]', 600 + 125, cardY + 40);
    }
  }

  // 6. Center Column: Available Pool (x=305, w=270)
  ctx.textAlign = 'center';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.fillText('📋 AVAILABLE DRAFT POOL', 440, 115);

  for (let i = 0; i < remaining.length; i++) {
    const p = remaining[i];
    const cardY = 130 + i * 85;
    await drawPlayerCard(p, 305, cardY, 270, 70, '#aa00ff', `AVAILABLE`);
  }

  return canvas.toBuffer('image/png');
}
