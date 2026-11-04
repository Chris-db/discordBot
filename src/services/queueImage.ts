import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { Player } from '../database/queries';
import { getDivisionTier, getStreakChip } from './mmrService';
import { logger } from '../utils/logger';
import { getCachedAvatarImage } from '../utils/avatarCache';
import { FONT_STACK } from '../utils/fonts';
import { P, overlay } from '../ui/palette';

/**
 * Generates the Lobby Queue Panel graphic: teamSize columns by 2 rows.
 *
 * The grid is one column per player-per-team, so 2v2 is 2x2, 3v3 is 3x2 and 4v4 is 4x2.
 * At teamSize 3 the arithmetic lands on exactly 840px, which is what the panel has always
 * been -- the 3v3 card is unchanged by multi-queue.
 *
 * Displays occupied slots with player avatars, names, and ratings, and empty slots with
 * "WAITING FOR PLAYER".
 */
export async function generateQueuePanelImage(
  client: Client,
  players: Player[],
  teamSize: number,
  /** The division this channel is registered to. Unregistered channels get the old cyan. */
  division?: string
): Promise<Buffer> {
  const cardW = 240;
  const cardH = 115;
  const gap = 20;
  const margin = 40;
  const capacity = teamSize * 2;

  const isFull = players.length === capacity;
  // The accent colour is the division's own -- the same one on the player cards below
  // and on every rank badge -- so five panels are told apart at a glance and the panel
  // agrees with the cards under it. A full queue goes emerald whatever the division: the
  // badge text says QUEUE FULL, and the colour change is what catches the eye.
  const tier = division ? getDivisionTier(division) : undefined;
  const accent = isFull ? P.positive : tier?.color ?? P.accent;
  const title = tier
    ? `${tier.name.toUpperCase()} ${teamSize}V${teamSize} QUEUE`
    : `🚀 ${teamSize}V${teamSize} MATCH QUEUE`;
  const badgeText = isFull
    ? `QUEUE FULL  •  ${capacity} / ${capacity} READY!`
    : `WAITING FOR PLAYERS  •  ${players.length} / ${capacity}`;

  // Measure the header before sizing the canvas: at 2v2 the grid alone is only 620px,
  // which is narrower than the title and status badge sitting side by side -- they used
  // to overlap.
  const measure = createCanvas(10, 10).getContext('2d');
  measure.font = `bold 26px ${FONT_STACK}`;
  const titleW = measure.measureText(title).width;
  measure.font = `bold 14px ${FONT_STACK}`;
  const badgeW = measure.measureText(badgeText).width + 32;

  const gridW = teamSize * cardW + (teamSize - 1) * gap;
  const headerW = titleW + 24 + badgeW;
  const width = margin * 2 + Math.max(gridW, headerW);
  const height = 380;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Centre the grid when the header is what forced the canvas wider.
  const gridLeft = Math.round((width - gridW) / 2);

  // 1. Dark background gradient
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, P.queueBg.top); // deep dark slate
  bgGradient.addColorStop(1, P.queueBg.bottom);
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Top accent line
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, width, 5);

  // 2. Title & Status Header
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `bold 26px ${FONT_STACK}`;
  ctx.fillText(title, 40, 50);

  // Status Badge on the right
  const badgeWidth = badgeW;
  const badgeX = width - 40 - badgeWidth;
  const badgeY = 25;
  const badgeH = 34;

  ctx.fillStyle = accent + '26'; // the accent at 15% alpha
  ctx.fillRect(badgeX, badgeY, badgeWidth, badgeH);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(badgeX, badgeY, badgeWidth, badgeH);

  ctx.textAlign = 'center';
  ctx.font = `bold 14px ${FONT_STACK}`;
  ctx.fillStyle = accent;
  ctx.fillText(badgeText, badgeX + badgeWidth / 2, badgeY + 22);

  // 3. Player slot cards, teamSize per row, two rows
  const rows = [85, 225];

  for (let i = 0; i < capacity; i++) {
    const colIdx = i % teamSize;
    const rowIdx = Math.floor(i / teamSize);
    const cardX = gridLeft + colIdx * (cardW + gap);
    const cardY = rows[rowIdx];
    const player = players[i];

    if (player) {
      // OCCUPIED SLOT
      const tier = getDivisionTier(player.division);

      // Card Background
      ctx.fillStyle = P.card;
      ctx.fillRect(cardX, cardY, cardW, cardH);

      // Card Border & Top Stripe
      ctx.strokeStyle = tier.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(cardX, cardY, cardW, cardH);
      ctx.fillStyle = tier.color;
      ctx.fillRect(cardX, cardY, cardW, 4);

      // Slot Number
      ctx.textAlign = 'right';
      ctx.fillStyle = P.textFaint;
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
        ctx.fillStyle = P.surface;
        ctx.fillRect(avatarCenterX - avatarRadius, avatarCenterY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
        ctx.fillStyle = P.white;
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
      ctx.fillStyle = P.text;
      ctx.font = `bold 18px ${FONT_STACK}`;
      const shortName = player.username.length > 11 ? player.username.substring(0, 10) + '…' : player.username;
      ctx.fillText(shortName, cardX + 85, cardY + 54);

      // MMR & Rating
      ctx.font = `bold 16px ${FONT_STACK}`;
      ctx.fillStyle = P.accent;
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
          ctx.fillStyle = P.streak.hot;
          ctx.fillRect(chipX, cardY + 71, chipW, 18);
          ctx.fillStyle = P.black;
          ctx.fillText(chip, chipX + 5, cardY + 84);
        }
      }
    } else {
      // EMPTY SLOT
      ctx.fillStyle = P.cardEmpty;
      ctx.fillRect(cardX, cardY, cardW, cardH);

      // Subtle Border
      ctx.strokeStyle = overlay(0.1);
      ctx.lineWidth = 1;
      ctx.strokeRect(cardX, cardY, cardW, cardH);

      // Slot Number
      ctx.textAlign = 'right';
      ctx.fillStyle = P.textDim;
      ctx.font = `bold 12px ${FONT_STACK}`;
      ctx.fillText(`#${i + 1}`, cardX + cardW - 12, cardY + 24);

      // Empty icon & text
      ctx.textAlign = 'center';
      ctx.fillStyle = overlay(0.08);
      ctx.font = `bold 28px ${FONT_STACK}`;
      ctx.fillText('+', cardX + cardW / 2, cardY + 55);

      ctx.fillStyle = P.textDim;
      ctx.font = `bold 14px ${FONT_STACK}`;
      ctx.fillText('WAITING FOR PLAYER', cardX + cardW / 2, cardY + 85);
    }
  }

  return canvas.toBuffer('image/png');
}
