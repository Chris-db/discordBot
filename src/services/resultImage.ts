import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { Player } from '../database/queries';
import { getDivisionTier, getPromotionStatus } from './mmrService';
import { getCachedAvatarImage } from '../utils/avatarCache';

export interface MatchPlayerResult {
  player: Player;
  delta: number;
  newMmr: number;
}

/**
 * Generates a 960x420 Match Victory & Promotion Canvas Graphic.
 * Celebrates the winning team, displays +MMR / -MMR deltas, and highlights Rank Tier promotions!
 */
export async function generateMatchResultImage(
  client: Client,
  matchId: number,
  winner: 'BLUE' | 'ORANGE',
  blueTeam: MatchPlayerResult[],
  orangeTeam: MatchPlayerResult[],
  durationStr?: string
): Promise<Buffer> {
  const width = 960;
  const height = 420;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Dark Background Gradient
  const bgGradient = ctx.createLinearGradient(0, 0, width, height);
  bgGradient.addColorStop(0, '#0f172a'); // slate-900
  bgGradient.addColorStop(1, '#1e293b'); // slate-800
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Winner color accent bar at the top
  const winColor = winner === 'BLUE' ? '#00b0ff' : '#ff9100';
  ctx.fillStyle = winColor;
  ctx.fillRect(0, 0, width, 6);

  // 2. Victory Header
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 34px sans-serif';
  const winTitle = winner === 'BLUE' ? '🔵  BLUE TEAM VICTORIOUS!  🔵' : '🟠  ORANGE TEAM VICTORIOUS!  🟠';
  ctx.fillText(winTitle, width / 2, 55);

  ctx.font = '600 16px sans-serif';
  ctx.fillStyle = '#94a3b8';
  const subtitle = durationStr
    ? `MATCH #${matchId}  •  OFFICIAL 6MANS RESULT  •  ⏱️ ${durationStr}`
    : `MATCH #${matchId}  •  OFFICIAL 6MANS RESULT`;
  ctx.fillText(subtitle, width / 2, 85);

  // 3. Render 2 team columns (Blue left, Orange right)
  const drawTeamColumn = async (
    teamName: string,
    teamColor: string,
    roster: MatchPlayerResult[],
    startX: number,
    isWinner: boolean
  ) => {
    // Header
    ctx.textAlign = 'left';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillStyle = teamColor;
    ctx.fillText(`${teamName} ${isWinner ? '👑 WINNER' : ''}`, startX, 130);

    // Render each player card
    const cardW = 410;
    const cardH = 80;
    for (let i = 0; i < roster.length; i++) {
      const item = roster[i];
      const cardY = 150 + i * (cardH + 12);

      // Card bg
      ctx.fillStyle = isWinner ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.03)';
      ctx.fillRect(startX, cardY, cardW, cardH);
      ctx.strokeStyle = isWinner ? teamColor : '#334155';
      ctx.lineWidth = isWinner ? 2 : 1;
      ctx.strokeRect(startX, cardY, cardW, cardH);

      // Left accent stripe
      ctx.fillStyle = teamColor;
      ctx.fillRect(startX, cardY, 4, cardH);

      // Avatar
      const avatarRadius = 26;
      const avatarX = startX + 40;
      const avatarY = cardY + cardH / 2;

      ctx.save();
      ctx.beginPath();
      ctx.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
      ctx.clip();

      try {
        const img = await getCachedAvatarImage(client, item.player.discord_id, 128);
        if (img) {
          ctx.drawImage(img, avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
        } else {
          throw new Error('Avatar fallback');
        }
      } catch {
        ctx.fillStyle = '#334155';
        ctx.fillRect(avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(item.player.username.charAt(0).toUpperCase() || '?', avatarX, avatarY + 6);
      }
      ctx.restore();

      // Username
      ctx.textAlign = 'left';
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 20px sans-serif';
      const nameStr = item.player.username.length > 13 ? item.player.username.substring(0, 12) + '…' : item.player.username;
      ctx.fillText(nameStr, startX + 78, cardY + 34);

      // New MMR & Tier Name
      const tier = getDivisionTier(item.player.division);
      ctx.font = '600 15px sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${item.newMmr} MMR (${tier.name})`, startX + 78, cardY + 60);

      // Delta Badge (+15 or -15) on the right
      const deltaText = item.delta >= 0 ? `+${item.delta} MMR` : `${item.delta} MMR`;
      const deltaColor = item.delta >= 0 ? '#00e676' : '#ff1744';
      ctx.textAlign = 'right';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillStyle = deltaColor;
      ctx.fillText(deltaText, startX + cardW - 20, cardY + 36);

      // Standing against the division's promotion / relegation line. Divisions only
      // change at a season reset, so this is a status, not a rank change -- the card
      // used to announce "PROMOTED TO RANK B!" the moment someone crossed 1200, which
      // is no longer something that happens mid-season.
      const zone = getPromotionStatus(item.player.guild_id, item.player.division, item.newMmr);
      if (zone) {
        const pillW = 140;
        const pillH = 22;
        const pillX = startX + cardW - 20 - pillW;
        const pillY = cardY + 46;

        ctx.fillStyle = zone.color;
        ctx.fillRect(pillX, pillY, pillW, pillH);

        ctx.textAlign = 'center';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = '#000000';
        ctx.fillText(zone.label, pillX + pillW / 2, pillY + 15);
      }
    }
  };

  await drawTeamColumn('TEAM BLUE 🔵', '#00b0ff', blueTeam, 40, winner === 'BLUE');
  await drawTeamColumn('TEAM ORANGE 🟠', '#ff9100', orangeTeam, 510, winner === 'ORANGE');

  return canvas.toBuffer('image/png');
}
