import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { Player } from '../database/queries';
import { getDivisionTier } from './mmrService';
import { logger } from '../utils/logger';
import { getCachedAvatarImage } from '../utils/avatarCache';
import { FONT_STACK } from '../utils/fonts';
import { P, overlay } from '../ui/palette';

/**
 * Generates a stunning Canvas leaderboard image graphic with one row per player:
 * Position (left) -> Profile Picture -> Name -> MMR Rating (far right).
 * Zero additional information.
 */
export async function generateLeaderboardImage(
  client: Client,
  players: Player[],
  page: number = 1,
  teamSize?: number
): Promise<Buffer> {
  const width = 900;
  const rowHeight = 64;
  const headerHeight = 70;
  const paddingBottom = 30;
  const height = headerHeight + Math.max(1, players.length) * rowHeight + paddingBottom;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Background (Sleek Dark Modern Theme)
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, P.bgTop); // slate-900
  bgGradient.addColorStop(1, P.bgBottom); // slate-800
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Subtle top border glow
  ctx.fillStyle = P.amber; // amber/gold accent
  ctx.fillRect(0, 0, width, 4);

  // 2. Table Header
  ctx.font = `bold 15px ${FONT_STACK}`;
  ctx.fillStyle = P.textFaint; // slate-500
  ctx.textAlign = 'left';
  ctx.fillText('POS', 40, 42);
  ctx.fillText('PLAYER', 170, 42);

  // Each size is a separate ladder, so the card has to say which one it is.
  const ladderLabel = teamSize ?? players[0]?.team_size;
  if (ladderLabel) {
    ctx.textAlign = 'center';
    ctx.fillStyle = P.amber;
    ctx.font = `bold 15px ${FONT_STACK}`;
    ctx.fillText(`${ladderLabel}V${ladderLabel}`, width / 2, 42);
    ctx.fillStyle = P.textFaint;
    ctx.font = `bold 15px ${FONT_STACK}`;
  }

  ctx.textAlign = 'right';
  ctx.fillText('MMR RATING', 860, 42);

  // Divider line under header
  ctx.strokeStyle = overlay(0.08);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(40, 54);
  ctx.lineTo(860, 54);
  ctx.stroke();

  if (players.length === 0) {
    ctx.font = `bold 20px ${FONT_STACK}`;
    ctx.fillStyle = P.textMuted;
    ctx.textAlign = 'center';
    ctx.fillText('No players found on the leaderboard yet.', width / 2, height / 2 + 10);
    return canvas.toBuffer('image/png');
  }

  // 3. Fetch user avatars in parallel
  const avatars = await Promise.all(
    players.map(async p => {
      return await getCachedAvatarImage(client, p.discord_id, 128);
    })
  );

  // 4. Draw each player row
  for (let idx = 0; idx < players.length; idx++) {
    const player = players[idx];
    const overallRank = (page - 1) * 10 + idx + 1;
    const y = headerHeight + idx * rowHeight;
    const tier = getDivisionTier(player.division);

    // Alternating row background
    if (idx % 2 === 1) {
      ctx.fillStyle = overlay(0.025);
      ctx.fillRect(20, y, width - 40, rowHeight);
    }

    // Rank Tier Vertical Accent Stripe (X=16, width 4)
    ctx.fillStyle = tier.color;
    ctx.fillRect(16, y + 10, 4, rowHeight - 20);

    // A. POSITION (Left, X=40)
    ctx.textAlign = 'left';
    ctx.font = `bold 22px ${FONT_STACK}`;
    if (overallRank === 1) {
      ctx.fillStyle = P.leaderboard.medalGold; // Gold
    } else if (overallRank === 2) {
      ctx.fillStyle = P.leaderboard.medalSilver; // Silver
    } else if (overallRank === 3) {
      ctx.fillStyle = P.leaderboard.medalBronze; // Bronze
    } else {
      ctx.fillStyle = P.textMuted; // Slate-400
    }
    ctx.fillText(`#${overallRank}`, 40, y + 40);

    // B. PROFILE PICTURE (X=105, Y=y+10, radius 22)
    const avatarX = 105;
    const avatarY = y + 10;
    const radius = 22;

    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + radius, avatarY + radius, radius, 0, Math.PI * 2, true);
    ctx.closePath();
    ctx.clip();

    const avatarImg = avatars[idx];
    if (avatarImg) {
      ctx.drawImage(avatarImg, avatarX, avatarY, radius * 2, radius * 2);
    } else {
      // Fallback initial circle
      ctx.fillStyle = P.surface;
      ctx.fillRect(avatarX, avatarY, radius * 2, radius * 2);
      ctx.fillStyle = P.white;
      ctx.font = `bold 18px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.fillText(
        player.username.charAt(0).toUpperCase() || '?',
        avatarX + radius,
        avatarY + radius + 6
      );
    }
    ctx.restore();

    // Subtle border around avatar
    ctx.strokeStyle = overallRank <= 3 ? P.leaderboard.medalGold : overlay(0.15);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(avatarX + radius, avatarY + radius, radius, 0, Math.PI * 2, true);
    ctx.stroke();

    // C. NAME (X=170)
    ctx.textAlign = 'left';
    ctx.font = overallRank <= 3 ? `bold 22px ${FONT_STACK}` : `600 20px ${FONT_STACK}`;
    ctx.fillStyle = P.text; // Crisp white
    ctx.fillText(player.username, 170, y + 40);

    // D. MMR RATING (Far Right, X=860)
    ctx.textAlign = 'right';
    ctx.font = `bold 22px ${FONT_STACK}`;
    ctx.fillStyle = P.sky; // Sky-400 cyan
    ctx.fillText(`${player.mmr} MMR`, 860, y + 40);

    // Subtle bottom border for row
    ctx.strokeStyle = overlay(0.04);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(40, y + rowHeight);
    ctx.lineTo(860, y + rowHeight);
    ctx.stroke();
  }

  return canvas.toBuffer('image/png');
}
