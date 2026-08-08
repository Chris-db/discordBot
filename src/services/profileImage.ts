import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { Player, getAverageMatchDuration } from '../database/queries';
import { getDivisionTier } from './mmrService';
import { logger } from '../utils/logger';
import { getCachedAvatarImage } from '../utils/avatarCache';

/**
 * Generates a custom Player Profile Banner graphic with Rank Tier badge,
 * MMR progress bar toward the next rank, and Stats boxes.
 */
export async function generatePlayerProfileImage(
  client: Client,
  player: Player,
  rank: number,
  totalPlayers: number
): Promise<Buffer> {
  const width = 800;
  const height = 380;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Dark Glassmorphism Background
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, '#0f172a'); // slate-900
  bgGradient.addColorStop(1, '#1e293b'); // slate-800
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  const tier = getDivisionTier(player.division);

  // Top accent colored bar
  ctx.fillStyle = tier.color;
  ctx.fillRect(0, 0, width, 5);

  // 2. Avatar & Header Info
  const avatarX = 45;
  const avatarY = 35;
  const radius = 45;

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX + radius, avatarY + radius, radius, 0, Math.PI * 2);
  ctx.clip();

  try {
    const img = await getCachedAvatarImage(client, player.discord_id, 256);
    if (img) {
      ctx.drawImage(img, avatarX, avatarY, radius * 2, radius * 2);
    } else {
      throw new Error('Avatar fallback');
    }
  } catch {
    ctx.fillStyle = '#334155';
    ctx.fillRect(avatarX, avatarY, radius * 2, radius * 2);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(player.username.charAt(0).toUpperCase() || '?', avatarX + radius, avatarY + radius + 14);
  }
  ctx.restore();

  // Glow ring around avatar
  ctx.strokeStyle = tier.color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(avatarX + radius, avatarY + radius, radius, 0, Math.PI * 2);
  ctx.stroke();

  // Username & Rank Badge
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(player.username, 160, 65);

  // Rank Tier Pill
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(160, 80, 220, 36);
  ctx.strokeStyle = tier.color;
  ctx.lineWidth = 2;
  ctx.strokeRect(160, 80, 220, 36);

  ctx.font = 'bold 18px sans-serif';
  ctx.fillStyle = tier.color;
  ctx.fillText(`${tier.emoji}  ${tier.name}`, 175, 104);

  // Server Position
  const rankText = rank > 0 ? `#${rank} of ${totalPlayers} players` : 'Unranked';
  ctx.font = '600 18px sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`SERVER STANDING: ${rankText}`, 410, 104);

  // 3. MMR Progress Bar toward next rank
  // Rank C (<1200), Rank B (1200-1400), Rank A (1400-1600), Rank X (1600-1800), Rank S (1800+)
  let currentBase = 0;
  let nextTarget = 1200;
  let nextRankName = 'Rank B';

  if (player.mmr >= 1800) {
    currentBase = 1800;
    nextTarget = 2000;
    nextRankName = 'Max SSL';
  } else if (player.mmr >= 1600) {
    currentBase = 1600;
    nextTarget = 1800;
    nextRankName = 'Rank S';
  } else if (player.mmr >= 1400) {
    currentBase = 1400;
    nextTarget = 1600;
    nextRankName = 'Rank X';
  } else if (player.mmr >= 1200) {
    currentBase = 1200;
    nextTarget = 1400;
    nextRankName = 'Rank A';
  } else {
    currentBase = 0;
    nextTarget = 1200;
    nextRankName = 'Rank B';
  }

  const progress = Math.max(0, Math.min(1, (player.mmr - currentBase) / (nextTarget - currentBase)));

  const barX = 45;
  const barY = 165;
  const barWidth = 710;
  const barHeight = 22;

  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 15px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`MMR PROGRESS (${player.mmr} / ${nextTarget})`, barX, barY - 10);
  ctx.textAlign = 'right';
  ctx.fillText(`Next: ${nextRankName}`, barX + barWidth, barY - 10);

  // Bar Background
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(barX, barY, barWidth, barHeight);

  // Progress Fill
  if (progress > 0) {
    ctx.fillStyle = tier.color;
    ctx.fillRect(barX, barY, Math.round(barWidth * progress), barHeight);
  }

  // 4. Stats Grids (4 cards at bottom: Win Rate, Record, Streak, Avg Match Time)
  const totalGames = player.wins + player.losses;
  const winRate = totalGames > 0 ? ((player.wins / totalGames) * 100).toFixed(1) : '0.0';

  const drawStatCard = (title: string, value: string, sub: string, x: string | number, color: string, cardW = 165) => {
    const cardH = 110;
    const cardY = 230;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(Number(x), cardY, cardW, cardH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Number(x), cardY, cardW, cardH);

    ctx.textAlign = 'center';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(title, Number(x) + cardW / 2, cardY + 30);

    ctx.font = 'bold 26px sans-serif';
    ctx.fillStyle = color;
    ctx.fillText(value, Number(x) + cardW / 2, cardY + 70);

    ctx.font = '600 12px sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText(sub, Number(x) + cardW / 2, cardY + 95);
  };

  drawStatCard('WIN RATE %', `${winRate}%`, `${totalGames} MATCHES`, 45, '#38bdf8');
  drawStatCard('W - L RECORD', `${player.wins}W - ${player.losses}L`, `PLAYED: ${totalGames}`, 226, '#f8fafc');

  const streakVal = player.streak > 0 ? `+${player.streak}` : player.streak < 0 ? `${player.streak}` : '0';
  const streakColor = player.streak > 0 ? '#00e676' : player.streak < 0 ? '#ff1744' : '#94a3b8';
  drawStatCard('STREAK', streakVal, player.streak > 0 ? 'WIN STREAK 🔥' : 'LOSS STREAK ❄️', 407, streakColor);

  const avgSecs = getAverageMatchDuration(player.discord_id);
  const avgTimeStr = avgSecs > 0 ? `${Math.floor(avgSecs / 60)}m ${avgSecs % 60}s` : 'N/A';
  drawStatCard('AVG TIME', avgTimeStr, 'PER MATCH ⏱️', 588, '#f59e0b', 167);

  return canvas.toBuffer('image/png');
}
