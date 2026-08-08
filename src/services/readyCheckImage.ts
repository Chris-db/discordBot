import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { Player } from '../database/queries';
import { getDivisionTier } from './mmrService';
import { getCachedAvatarImage } from '../utils/avatarCache';
import { FONT_STACK } from '../utils/fonts';

/**
 * Generates the AFK Voice Ready Check graphic: teamSize columns by 2 rows, matching the
 * queue panel's layout so the two cards read as the same lobby.
 *
 * Displays every queued player with a live status indicator showing who is in voice and
 * who is missing.
 */
export async function generateReadyCheckImage(
  client: Client,
  players: Player[],
  readyPlayerIds: string[],
  remainingSeconds: number,
  teamSize: number
): Promise<Buffer> {
  const cardW = 240;
  const cardH = 95;
  const gap = 20;
  const margin = 40;
  const capacity = teamSize * 2;

  // The status line is centred and long ("ALL 4 PLAYERS MUST JOIN VOICE — TIME
  // REMAINING: 42s"), so at 2v2 it is wider than the grid and has to set the canvas.
  const statusMsg = `⏳ ALL ${capacity} PLAYERS MUST JOIN VOICE — TIME REMAINING: ${remainingSeconds}s`;
  const measure = createCanvas(10, 10).getContext('2d');
  measure.font = `bold 16px ${FONT_STACK}`;
  const statusW = measure.measureText(statusMsg).width;

  const gridW = teamSize * cardW + (teamSize - 1) * gap;
  const width = margin * 2 + Math.max(gridW, statusW);
  const height = 320;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const gridLeft = Math.round((width - gridW) / 2);

  // 1. Background gradient
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, '#0f172a');
  bgGradient.addColorStop(1, '#1e293b');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Top accent line
  const allReady = players.every(p => readyPlayerIds.includes(p.discord_id) || p.discord_id.startsWith('test_bot_'));
  ctx.fillStyle = allReady ? '#00e676' : '#ff9100';
  ctx.fillRect(0, 0, width, 5);

  // 2. Header
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f8fafc';
  ctx.font = `bold 28px ${FONT_STACK}`;
  ctx.fillText(`🔊 AFK VOICE READY CHECK (${capacity} / ${capacity})`, width / 2, 45);

  ctx.font = `bold 16px ${FONT_STACK}`;
  ctx.fillStyle = allReady ? '#00e676' : '#ff9100';
  ctx.fillText(
    allReady ? '✅ ALL PLAYERS READY! LAUNCHING MODE VOTING...' : statusMsg,
    width / 2,
    72
  );

  // 3. Player grid, teamSize per row, two rows
  const rows = [95, 205];

  for (let i = 0; i < capacity; i++) {
    const p = players[i];
    const colIdx = i % teamSize;
    const rowIdx = Math.floor(i / teamSize);
    const x = gridLeft + colIdx * (cardW + gap);
    const y = rows[rowIdx];

    if (!p) continue;

    const isReady = readyPlayerIds.includes(p.discord_id) || p.discord_id.startsWith('test_bot_');
    const colorHex = isReady ? '#00e676' : '#ff9100';

    // Card background
    ctx.fillStyle = isReady ? 'rgba(0, 230, 118, 0.08)' : 'rgba(255, 145, 0, 0.08)';
    ctx.fillRect(x, y, cardW, cardH);
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, cardW, cardH);

    // Left Stripe
    ctx.fillStyle = colorHex;
    ctx.fillRect(x, y, 4, cardH);

    // Avatar
    const radius = 24;
    const ax = x + 38;
    const ay = y + cardH / 2;

    ctx.save();
    ctx.beginPath();
    ctx.arc(ax, ay, radius, 0, Math.PI * 2);
    ctx.clip();

    try {
      const img = await getCachedAvatarImage(client, p.discord_id, 128);
      if (img) {
        ctx.drawImage(img, ax - radius, ay - radius, radius * 2, radius * 2);
      } else {
        throw new Error('Avatar fallback');
      }
    } catch {
      ctx.fillStyle = '#334155';
      ctx.fillRect(ax - radius, ay - radius, radius * 2, radius * 2);
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold 16px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.fillText(p.username.charAt(0).toUpperCase() || '?', ax, ay + 6);
    }
    ctx.restore();

    // Glowing Avatar Ring
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(ax, ay, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Username
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f8fafc';
    ctx.font = `bold 18px ${FONT_STACK}`;
    const shortName = p.username.length > 11 ? p.username.substring(0, 10) + '…' : p.username;
    ctx.fillText(shortName, x + 74, y + 36);

    // Status Pill
    ctx.font = `bold 14px ${FONT_STACK}`;
    ctx.fillStyle = colorHex;
    ctx.fillText(isReady ? '✅ READY (IN VOICE)' : '⏳ WAITING...', x + 74, y + 65);
  }

  return canvas.toBuffer('image/png');
}
