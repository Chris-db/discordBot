import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { Player } from '../database/queries';
import { getDivisionTier, getStreakChip } from './mmrService';
import { logger } from '../utils/logger';
import { getCachedAvatarImage } from '../utils/avatarCache';
import { FONT_STACK } from '../utils/fonts';

/**
 * Generates an 840x380 6-Slot Lobby Queue Panel Canvas Graphic.
 * Displays occupied slots with player avatars, names, and ratings,
 * and empty slots with "WAITING FOR PLAYER".
 */
export async function generateQueuePanelImage(
  client: Client,
  players: Player[]
): Promise<Buffer> {
  const width = 840;
  const height = 380;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Dark background gradient
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, '#0b0f19'); // deep dark slate
  bgGradient.addColorStop(1, '#111827');
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Top accent line (cyan or emerald when full)
  const isFull = players.length === 6;
  ctx.fillStyle = isFull ? '#00e676' : '#00b0ff';
  ctx.fillRect(0, 0, width, 5);

  // 2. Title & Status Header
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f8fafc';
  ctx.font = `bold 26px ${FONT_STACK}`;
  ctx.fillText('🚀 6MANS MATCH QUEUE', 40, 50);

  // Status Badge on the right
  const badgeText = isFull ? 'QUEUE FULL  •  6 / 6 READY!' : `WAITING FOR PLAYERS  •  ${players.length} / 6`;
  const badgeWidth = isFull ? 240 : 260;
  const badgeX = width - 40 - badgeWidth;
  const badgeY = 25;
  const badgeH = 34;

  ctx.fillStyle = isFull ? 'rgba(0, 230, 118, 0.15)' : 'rgba(0, 176, 255, 0.15)';
  ctx.fillRect(badgeX, badgeY, badgeWidth, badgeH);
  ctx.strokeStyle = isFull ? '#00e676' : '#00b0ff';
  ctx.lineWidth = 2;
  ctx.strokeRect(badgeX, badgeY, badgeWidth, badgeH);

  ctx.textAlign = 'center';
  ctx.font = `bold 14px ${FONT_STACK}`;
  ctx.fillStyle = isFull ? '#00e676' : '#00b0ff';
  ctx.fillText(badgeText, badgeX + badgeWidth / 2, badgeY + 22);

  // 3. 6 Player Slot Cards (2x3 Grid)
  const cardW = 240;
  const cardH = 115;
  const cols = [40, 300, 560];
  const rows = [85, 225];

  for (let i = 0; i < 6; i++) {
    const colIdx = i % 3;
    const rowIdx = Math.floor(i / 3);
    const cardX = cols[colIdx];
    const cardY = rows[rowIdx];
    const player = players[i];

    if (player) {
      // OCCUPIED SLOT
      const tier = getDivisionTier(player.division);

      // Card Background
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(cardX, cardY, cardW, cardH);

      // Card Border & Top Stripe
      ctx.strokeStyle = tier.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(cardX, cardY, cardW, cardH);
      ctx.fillStyle = tier.color;
      ctx.fillRect(cardX, cardY, cardW, 4);

      // Slot Number
      ctx.textAlign = 'right';
      ctx.fillStyle = '#64748b';
      ctx.font = `bold 12px ${FONT_STACK}`;
      ctx.fillText(`#${i + 1}`, cardX + cardW - 12, cardY + 24);

      // Player Avatar (Circle)
      const avatarRadius = 28;
      const avatarCenterX = cardX + 45;
      const avatarCenterY = cardY + cardH / 2 + 5;

      ctx.save();
      ctx.beginPath();
      ctx.arc(avatarCenterX, avatarCenterY, avatarRadius, 0, Math.PI * 2);
      ctx.clip();

      try {
        const img = await getCachedAvatarImage(client, player.discord_id, 128);
        if (img) {
          ctx.drawImage(img, avatarCenterX - avatarRadius, avatarCenterY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
        } else {
          throw new Error('Avatar fallback');
        }
      } catch {
        // Fallback initials
        ctx.fillStyle = '#334155';
        ctx.fillRect(avatarCenterX - avatarRadius, avatarCenterY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold 20px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.fillText(player.username.charAt(0).toUpperCase() || '?', avatarCenterX, avatarCenterY + 7);
      }
      ctx.restore();

      // Glowing Avatar Ring
      ctx.strokeStyle = tier.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(avatarCenterX, avatarCenterY, avatarRadius, 0, Math.PI * 2);
      ctx.stroke();

      // Username
      ctx.textAlign = 'left';
      ctx.fillStyle = '#f8fafc';
      ctx.font = `bold 18px ${FONT_STACK}`;
      const shortName = player.username.length > 11 ? player.username.substring(0, 10) + '…' : player.username;
      ctx.fillText(shortName, cardX + 85, cardY + 54);

      // MMR & Rating
      ctx.font = `bold 16px ${FONT_STACK}`;
      ctx.fillStyle = '#00b0ff';
      ctx.fillText(`${player.mmr} MMR`, cardX + 85, cardY + 84);

      // Hot streak, next to the MMR. Someone on a run is worth knowing about before
      // teams are picked, and streak was previously only visible in /stats.
      const chip = getStreakChip(player.streak);
      if (chip) {
        const mmrWidth = ctx.measureText(`${player.mmr} MMR`).width;
        const chipX = cardX + 85 + mmrWidth + 8;
        ctx.font = `bold 13px ${FONT_STACK}`;
        const chipW = ctx.measureText(chip).width + 10;

        if (chipX + chipW < cardX + cardW - 8) {
          ctx.fillStyle = '#ffab00';
          ctx.fillRect(chipX, cardY + 71, chipW, 18);
          ctx.fillStyle = '#000000';
          ctx.fillText(chip, chipX + 5, cardY + 84);
        }
      }
    } else {
      // EMPTY SLOT
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(cardX, cardY, cardW, cardH);

      // Subtle Border
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1;
      ctx.strokeRect(cardX, cardY, cardW, cardH);

      // Slot Number
      ctx.textAlign = 'right';
      ctx.fillStyle = '#475569';
      ctx.font = `bold 12px ${FONT_STACK}`;
      ctx.fillText(`#${i + 1}`, cardX + cardW - 12, cardY + 24);

      // Empty icon & text
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.font = `bold 28px ${FONT_STACK}`;
      ctx.fillText('+', cardX + cardW / 2, cardY + 55);

      ctx.fillStyle = '#475569';
      ctx.font = `bold 14px ${FONT_STACK}`;
      ctx.fillText('WAITING FOR PLAYER', cardX + cardW / 2, cardY + 85);
    }
  }

  // Footer text
  ctx.textAlign = 'center';
  ctx.fillStyle = '#475569';
  ctx.font = `12px ${FONT_STACK}`;
  ctx.fillText('Click Join Queue below to claim your spot in the lobby', width / 2, height - 16);

  return canvas.toBuffer('image/png');
}
