import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { Player } from '../database/queries';
import { getDivisionTier, getPromotionStatus, getStreakBadge } from './mmrService';
import { getCachedAvatarImage } from '../utils/avatarCache';
import { FONT_STACK } from '../utils/fonts';
import { P, overlay } from '../ui/palette';

export interface MatchPlayerResult {
  /** Post-match row, so `streak` is the streak this result just produced. */
  player: Player;
  delta: number;
  newMmr: number;
  /** Streak before the match, used to tell a new streak from a continuing one. */
  previousStreak?: number;
}

/**
 * Generates a 960x420 Match Victory & Promotion Canvas Graphic.
 * Celebrates the winning team, displays +MMR / -MMR deltas, and highlights Rank Tier promotions!
 */
export async function generateMatchResultImage(
  client: Client,
  /** The per-server display number, not the database match_id. */
  matchNumber: number,
  winner: 'BLUE' | 'ORANGE',
  blueTeam: MatchPlayerResult[],
  orangeTeam: MatchPlayerResult[],
  durationStr?: string
): Promise<Buffer> {
  // Cards start at y=150 with a 92px pitch, so the canvas has to grow with the roster:
  // four a side would run off the old fixed 420px.
  const rosterRows = Math.max(blueTeam.length, orangeTeam.length);
  const width = 960;
  const height = 150 + rosterRows * 92 + 10;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Dark Background Gradient
  const bgGradient = ctx.createLinearGradient(0, 0, width, height);
  bgGradient.addColorStop(0, P.bgTop); // slate-900
  bgGradient.addColorStop(1, P.bgBottom); // slate-800
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Winner color accent bar at the top
  const winColor = winner === 'BLUE' ? P.team.blue : P.team.orange;
  ctx.fillStyle = winColor;
  ctx.fillRect(0, 0, width, 6);

  // 2. Victory Header
  ctx.textAlign = 'center';
  ctx.fillStyle = P.text;
  ctx.font = `bold 34px ${FONT_STACK}`;
  const winTitle = winner === 'BLUE' ? '🔵  BLUE TEAM VICTORIOUS!  🔵' : '🟠  ORANGE TEAM VICTORIOUS!  🟠';
  ctx.fillText(winTitle, width / 2, 55);

  ctx.font = `600 16px ${FONT_STACK}`;
  ctx.fillStyle = P.textMuted;
  const subtitle = durationStr
    ? `MATCH #${matchNumber}  •  OFFICIAL 6MANS RESULT  •  ⏱️ ${durationStr}`
    : `MATCH #${matchNumber}  •  OFFICIAL 6MANS RESULT`;
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
    ctx.font = `bold 22px ${FONT_STACK}`;
    ctx.fillStyle = teamColor;
    ctx.fillText(`${teamName} ${isWinner ? '👑 WINNER' : ''}`, startX, 130);

    // Render each player card
    const cardW = 410;
    const cardH = 80;
    for (let i = 0; i < roster.length; i++) {
      const item = roster[i];
      const cardY = 150 + i * (cardH + 12);

      // Card bg
      ctx.fillStyle = isWinner ? overlay(0.08) : overlay(0.03);
      ctx.fillRect(startX, cardY, cardW, cardH);
      ctx.strokeStyle = isWinner ? teamColor : P.surface;
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
        ctx.fillStyle = P.surface;
        ctx.fillRect(avatarX - avatarRadius, avatarY - avatarRadius, avatarRadius * 2, avatarRadius * 2);
        ctx.fillStyle = P.white;
        ctx.font = `bold 18px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.fillText(item.player.username.charAt(0).toUpperCase() || '?', avatarX, avatarY + 6);
      }
      ctx.restore();

      // Username. Shortened when a streak badge needs to sit beside it.
      const streak = getStreakBadge(item.player.streak);
      ctx.textAlign = 'left';
      ctx.fillStyle = P.text;
      ctx.font = `bold 20px ${FONT_STACK}`;
      const maxNameChars = streak ? 9 : 13;
      const nameStr =
        item.player.username.length > maxNameChars
          ? item.player.username.substring(0, maxNameChars - 1) + '…'
          : item.player.username;
      ctx.fillText(nameStr, startX + 78, cardY + 34);

      // Streak badge, immediately after the name so it reads as part of it.
      if (streak) {
        const nameWidth = ctx.measureText(nameStr).width;
        const badgeX = startX + 78 + nameWidth + 10;
        ctx.font = `bold 13px ${FONT_STACK}`;
        const badgeW = ctx.measureText(streak.full).width + 14;

        // Only draw it if it fits without running under the delta on the right.
        if (badgeX + badgeW < startX + cardW - 110) {
          ctx.fillStyle = streak.color;
          ctx.fillRect(badgeX, cardY + 19, badgeW, 20);
          ctx.fillStyle = P.black;
          ctx.textAlign = 'left';
          ctx.fillText(streak.full, badgeX + 7, cardY + 33);
        }
      }

      // New MMR & Tier Name
      const tier = getDivisionTier(item.player.division);
      ctx.textAlign = 'left';
      ctx.font = `600 15px ${FONT_STACK}`;
      ctx.fillStyle = P.textMuted;
      ctx.fillText(`${item.newMmr} MMR (${tier.name})`, startX + 78, cardY + 60);

      // Delta Badge (+15 or -15) on the right
      const deltaText = item.delta >= 0 ? `+${item.delta} MMR` : `${item.delta} MMR`;
      const deltaColor = item.delta >= 0 ? P.positive : P.negative;
      ctx.textAlign = 'right';
      ctx.font = `bold 18px ${FONT_STACK}`;
      ctx.fillStyle = deltaColor;
      ctx.fillText(deltaText, startX + cardW - 20, cardY + 36);

      // Standing against the division's promotion / relegation line. Divisions only
      // change at a season reset, so this is a status, not a rank change -- the card
      // used to announce "PROMOTED TO RANK B!" the moment someone crossed 1200, which
      // is no longer something that happens mid-season.
      const zone = getPromotionStatus(
        item.player.guild_id,
        item.player.team_size,
        item.player.division,
        item.newMmr,
        item.newMmr - item.delta
      );
      if (zone) {
        const pillW = 140;
        const pillH = 22;
        const pillX = startX + cardW - 20 - pillW;
        const pillY = cardY + 46;

        ctx.fillStyle = zone.color;
        ctx.fillRect(pillX, pillY, pillW, pillH);

        ctx.textAlign = 'center';
        ctx.font = `bold 11px ${FONT_STACK}`;
        ctx.fillStyle = P.black;
        ctx.fillText(zone.label, pillX + pillW / 2, pillY + 15);
      }
    }
  };

  await drawTeamColumn('TEAM BLUE 🔵', P.team.blue, blueTeam, 40, winner === 'BLUE');
  await drawTeamColumn('TEAM ORANGE 🟠', P.team.orange, orangeTeam, 510, winner === 'ORANGE');

  return canvas.toBuffer('image/png');
}
