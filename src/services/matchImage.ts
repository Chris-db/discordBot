import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { Player } from '../database/queries';
import { getDivisionTier } from './mmrService';
import { logger } from '../utils/logger';
import { getCachedAvatarImage } from '../utils/avatarCache';
import { FONT_STACK } from '../utils/fonts';
import { P, overlay } from '../ui/palette';

/**
 * Generates an esports broadcast "VS" Match Card graphic for 3v3 lobbies.
 */
export async function generateMatchVsImage(
  client: Client,
  /** The per-server display number, not the database match_id. */
  matchNumber: number,
  blueTeam: Player[],
  orangeTeam: Player[]
): Promise<Buffer> {
  // Rows start at y=100 with an 80px pitch, so the canvas grows with the roster: at 4v4
  // the fourth row would otherwise run off the old fixed 400px.
  const rosterRows = Math.max(blueTeam.length, orangeTeam.length);
  const width = 960;
  const height = Math.max(400, 100 + rosterRows * 80 + 36);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Dual-color gradient background (Blue vs Orange theme)
  const bgGradient = ctx.createLinearGradient(0, 0, width, 0);
  bgGradient.addColorStop(0, P.matchVs.bgTop); // Deep navy blue
  bgGradient.addColorStop(0.48, P.bgTop); // Slate center
  bgGradient.addColorStop(0.52, P.bgTop); // Slate center
  bgGradient.addColorStop(1, P.matchVs.bgBottom); // Deep burnt orange
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Top/bottom accent border
  const borderGrad = ctx.createLinearGradient(0, 0, width, 0);
  borderGrad.addColorStop(0, P.sky); // Cyan
  borderGrad.addColorStop(0.5, P.amber); // Gold
  borderGrad.addColorStop(1, P.matchVs.orange); // Orange
  ctx.fillStyle = borderGrad;
  ctx.fillRect(0, 0, width, 4);
  ctx.fillRect(0, height - 4, width, 4);

  // 2. Center "VS" Badge
  ctx.save();
  ctx.fillStyle = P.card;
  ctx.strokeStyle = P.amber;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(width / 2, 160, 45, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = P.gold;
  ctx.font = `bold 36px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.fillText('VS', width / 2, 172);

  ctx.fillStyle = P.textMuted;
  ctx.font = `bold 16px ${FONT_STACK}`;
  ctx.fillText(`MATCH #${matchNumber}`, width / 2, 230);
  ctx.fillStyle = P.textFaint;
  ctx.font = `bold 13px ${FONT_STACK}`;
  ctx.fillText('ROCKET LEAGUE 6MANS', width / 2, 252);
  ctx.restore();

  // 3. Team Headers
  const blueAvg = Math.round(blueTeam.reduce((sum, p) => sum + p.mmr, 0) / (blueTeam.length || 1));
  const orangeAvg = Math.round(orangeTeam.reduce((sum, p) => sum + p.mmr, 0) / (orangeTeam.length || 1));

  ctx.textAlign = 'left';
  ctx.font = `bold 22px ${FONT_STACK}`;
  ctx.fillStyle = P.sky;
  ctx.fillText('🔵  TEAM BLUE', 50, 45);
  ctx.font = `16px ${FONT_STACK}`;
  ctx.fillStyle = P.textMuted;
  ctx.fillText(`AVG: ${blueAvg} MMR`, 50, 68);

  ctx.textAlign = 'right';
  ctx.font = `bold 22px ${FONT_STACK}`;
  ctx.fillStyle = P.matchVs.orange;
  ctx.fillText('TEAM ORANGE  🟠', width - 50, 45);
  ctx.font = `16px ${FONT_STACK}`;
  ctx.fillStyle = P.textMuted;
  ctx.fillText(`AVG: ${orangeAvg} MMR`, width - 50, 68);

  // 4. Fetch avatars for every player in the lobby
  const fetchAvatar = async (p: Player) => {
    return await getCachedAvatarImage(client, p.discord_id, 128);
  };

  const blueAvatars = await Promise.all(blueTeam.map(fetchAvatar));
  const orangeAvatars = await Promise.all(orangeTeam.map(fetchAvatar));

  // 5. Draw Blue Team Players (Left Side, X=50)
  const drawPlayerRow = (
    player: Player,
    avatar: any,
    x: number,
    y: number,
    align: 'left' | 'right',
    color: string
  ) => {
    const tier = getDivisionTier(player.division);
    const radius = 22;

    // Background card for player
    ctx.fillStyle = overlay(0.04);
    const cardX = align === 'left' ? x : x - 370;
    ctx.fillRect(cardX, y - 5, 370, 64);

    // Rank accent stripe
    ctx.fillStyle = tier.color;
    const stripeX = align === 'left' ? cardX : cardX + 366;
    ctx.fillRect(stripeX, y - 5, 4, 64);

    // Avatar Circle
    const avatarX = align === 'left' ? x + 20 : x - 20 - radius * 2;
    const avatarY = y + 5;

    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + radius, avatarY + radius, radius, 0, Math.PI * 2);
    ctx.clip();
    if (avatar) {
      ctx.drawImage(avatar, avatarX, avatarY, radius * 2, radius * 2);
    } else {
      ctx.fillStyle = P.surface;
      ctx.fillRect(avatarX, avatarY, radius * 2, radius * 2);
      ctx.fillStyle = P.white;
      ctx.font = `bold 18px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.fillText(player.username.charAt(0).toUpperCase() || '?', avatarX + radius, avatarY + radius + 6);
    }
    ctx.restore();

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(avatarX + radius, avatarY + radius, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Name & MMR
    ctx.font = `bold 19px ${FONT_STACK}`;
    ctx.fillStyle = P.text;
    if (align === 'left') {
      ctx.textAlign = 'left';
      ctx.fillText(player.username, avatarX + 55, avatarY + 20);
      ctx.font = `600 15px ${FONT_STACK}`;
      ctx.fillStyle = tier.color;
      ctx.fillText(`${tier.emoji} ${tier.name}`, avatarX + 55, avatarY + 41);

      ctx.textAlign = 'right';
      ctx.font = `bold 18px ${FONT_STACK}`;
      ctx.fillStyle = P.sky;
      ctx.fillText(`${player.mmr} MMR`, cardX + 355, avatarY + 28);
    } else {
      ctx.textAlign = 'right';
      ctx.fillText(player.username, avatarX - 15, avatarY + 20);
      ctx.font = `600 15px ${FONT_STACK}`;
      ctx.fillStyle = tier.color;
      ctx.fillText(`${tier.name} ${tier.emoji}`, avatarX - 15, avatarY + 41);

      ctx.textAlign = 'left';
      ctx.font = `bold 18px ${FONT_STACK}`;
      ctx.fillStyle = P.matchVs.orange;
      ctx.fillText(`${player.mmr} MMR`, cardX + 15, avatarY + 28);
    }
  };

  for (let i = 0; i < blueTeam.length; i++) {
    const y = 100 + i * 80;
    drawPlayerRow(blueTeam[i], blueAvatars[i], 50, y, 'left', P.sky);
  }

  for (let i = 0; i < orangeTeam.length; i++) {
    const y = 100 + i * 80;
    drawPlayerRow(orangeTeam[i], orangeAvatars[i], width - 50, y, 'right', P.matchVs.orange);
  }

  return canvas.toBuffer('image/png');
}
