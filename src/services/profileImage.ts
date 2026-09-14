import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { ProfileCardData } from './profileCard';
import { getDivisionTier } from './mmrService';
import { logger } from '../utils/logger';
import { getCachedAvatarImage } from '../utils/avatarCache';
import { FONT_STACK } from '../utils/fonts';
import { P, overlay } from '../ui/palette';

/**
 * Generates a custom Player Profile Banner graphic with Rank Tier badge, MMR progress bar
 * and four stat boxes. Everything it shows arrives in `data` (see loadProfileCard), so the
 * renderer itself touches no database and can be drawn from fixtures.
 */
export async function generatePlayerProfileImage(client: Client, data: ProfileCardData): Promise<Buffer> {
  const { player, rank, totalPlayers } = data;
  const width = 800;
  const height = 380;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Dark Glassmorphism Background
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, P.bgTop); // slate-900
  bgGradient.addColorStop(1, P.bgBottom); // slate-800
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
    ctx.fillStyle = P.surface;
    ctx.fillRect(avatarX, avatarY, radius * 2, radius * 2);
    ctx.fillStyle = P.white;
    ctx.font = `bold 36px ${FONT_STACK}`;
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
  ctx.fillStyle = P.text;
  ctx.font = `bold 32px ${FONT_STACK}`;
  ctx.fillText(player.username, 160, 65);

  // Rank Tier Pill
  ctx.fillStyle = overlay(0.08);
  ctx.fillRect(160, 80, 220, 36);
  ctx.strokeStyle = tier.color;
  ctx.lineWidth = 2;
  ctx.strokeRect(160, 80, 220, 36);

  ctx.font = `bold 18px ${FONT_STACK}`;
  ctx.fillStyle = tier.color;
  ctx.fillText(`${tier.emoji}  ${tier.name}`, 175, 104);

  // Server Position
  const rankText = rank > 0 ? `#${rank} of ${totalPlayers} players` : 'Unranked';
  ctx.font = `600 18px ${FONT_STACK}`;
  ctx.fillStyle = P.textMuted;
  ctx.fillText(`SERVER STANDING: ${rankText}`, 410, 104);

  // 3. MMR progress bar -- target and caption decided in profileCard.ts from the guild's
  // own divisions, so a one-ladder server is never told about a Rank B it does not have.
  const { bar } = data;
  const progress = bar.progress;

  const barX = 45;
  const barY = 165;
  const barWidth = 710;
  const barHeight = 22;

  ctx.fillStyle = P.textFaint;
  ctx.font = `bold 15px ${FONT_STACK}`;
  ctx.textAlign = 'left';
  ctx.fillText(`MMR ${player.mmr} / ${bar.to}`, barX, barY - 10);
  ctx.textAlign = 'right';
  ctx.fillText(bar.label, barX + barWidth, barY - 10);

  // Bar Background
  ctx.fillStyle = overlay(0.08);
  ctx.fillRect(barX, barY, barWidth, barHeight);

  // Progress Fill
  if (progress > 0) {
    ctx.fillStyle = tier.color;
    ctx.fillRect(barX, barY, Math.round(barWidth * progress), barHeight);
  }

  // 4. Stats Grids (4 cards at bottom: Win Rate, Games, Streak, Best Teammate)
  const totalGames = player.wins + player.losses;
  const winRate = totalGames > 0 ? ((player.wins / totalGames) * 100).toFixed(1) : '0.0';

  const drawStatCard = (title: string, value: string, sub: string, x: string | number, color: string, cardW = 165) => {
    const cardH = 110;
    const cardY = 230;

    ctx.fillStyle = overlay(0.04);
    ctx.fillRect(Number(x), cardY, cardW, cardH);
    ctx.strokeStyle = overlay(0.1);
    ctx.lineWidth = 1;
    ctx.strokeRect(Number(x), cardY, cardW, cardH);

    ctx.textAlign = 'center';
    ctx.font = `bold 13px ${FONT_STACK}`;
    ctx.fillStyle = P.textMuted;
    ctx.fillText(title, Number(x) + cardW / 2, cardY + 30);

    ctx.font = `bold 26px ${FONT_STACK}`;
    ctx.fillStyle = color;
    ctx.fillText(value, Number(x) + cardW / 2, cardY + 70);

    ctx.font = `600 12px ${FONT_STACK}`;
    ctx.fillStyle = P.textFaint;
    ctx.fillText(sub, Number(x) + cardW / 2, cardY + 95);
  };

  drawStatCard('WIN RATE %', `${winRate}%`, `${totalGames} MATCHES`, 45, P.sky);
  drawStatCard('GAMES', `${totalGames}`, `${player.wins}W - ${player.losses}L`, 226, P.text);

  const streakVal = player.streak > 0 ? `+${player.streak}` : player.streak < 0 ? `${player.streak}` : '0';
  const streakColor = player.streak > 0 ? P.positive : player.streak < 0 ? P.negative : P.textMuted;
  const streakSub = player.streak > 0 ? 'WIN STREAK 🔥' : player.streak < 0 ? 'LOSS STREAK ❄️' : 'NO STREAK';
  drawStatCard('STREAK', streakVal, streakSub, 407, streakColor);

  // Replaced average match time, which measured lobby-to-report across every server the
  // player is on and meant nothing to anyone.
  const mate = data.bestTeammate;
  drawStatCard(
    'BEST TEAMMATE',
    mate ? fitText(ctx, mate.username, 150, `bold 26px ${FONT_STACK}`) : '—',
    mate ? `${mate.wins} WIN${mate.wins === 1 ? '' : 'S'} TOGETHER 🤝` : 'NO WINS YET',
    588,
    P.amber,
    167
  );

  return canvas.toBuffer('image/png');
}

/** Trims a string with an ellipsis until it fits `maxWidth` in the given font. */
function fitText(ctx: import('@napi-rs/canvas').SKRSContext2D, text: string, maxWidth: number, font: string): string {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}
