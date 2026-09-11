import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { Player } from '../database/queries';
import { getDivisionTier, getPromotionStatus } from './mmrService';
import { getCachedAvatarImage } from '../utils/avatarCache';
import { FONT_STACK } from '../utils/fonts';
import { P, overlay } from '../ui/palette';

export interface GamblePlayerResult {
  player: Player;
  delta: number;
  newMmr: number;
}

/**
 * Generates a 960x420 Wheel of Fate Gamble Result Canvas Graphic.
 * Displays whether the match outcome was INVERTED (stolen victory) or DOUBLED (jackpot),
 * along with the updated player MMRs and deltas.
 */
export async function generateGambleResultImage(
  client: Client,
  /** The per-server display number, not the database match_id. */
  matchNumber: number,
  wheelWinner: 'BLUE' | 'ORANGE',
  resultType: 'INVERTED' | 'DOUBLED',
  blueTeam: GamblePlayerResult[],
  orangeTeam: GamblePlayerResult[]
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
  if (resultType === 'INVERTED') {
    bgGradient.addColorStop(0, P.gamble.stoneTop); // stone-900
    bgGradient.addColorStop(1, P.gamble.stoneBottom); // stone-800
  } else {
    bgGradient.addColorStop(0, P.gamble.redTop); // red-950
    bgGradient.addColorStop(1, P.gamble.redBottom);
  }
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Top accent bar
  const accentColor = resultType === 'INVERTED' ? P.gold : P.negative;
  ctx.fillStyle = accentColor;
  ctx.fillRect(0, 0, width, 6);

  // 2. Main Title & Subtitle
  ctx.textAlign = 'center';
  ctx.fillStyle = P.text;
  ctx.font = `bold 34px ${FONT_STACK}`;
  const titleText =
    resultType === 'INVERTED'
      ? '💥  WHEEL OF FATE: RESULT INVERTED!  💥'
      : '🔥  WHEEL OF FATE: RESULT DOUBLED!  🔥';
  ctx.fillText(titleText, width / 2, 55);

  ctx.font = `bold 16px ${FONT_STACK}`;
  ctx.fillStyle = resultType === 'INVERTED' ? P.gamble.invertedText : P.gamble.doubledText;
  const subText =
    resultType === 'INVERTED'
      ? `MATCH #${matchNumber}  •  TEAM ${wheelWinner} WON THE 50/50 & STOLE THE MMR!`
      : `MATCH #${matchNumber}  •  TEAM ${wheelWinner} WON THE 50/50 & DOUBLED THEIR MMR!`;
  ctx.fillText(subText, width / 2, 85);

  // 3. Render Team Columns
  const drawTeamColumn = async (
    teamName: string,
    teamColor: string,
    roster: GamblePlayerResult[],
    startX: number,
    isWinner: boolean
  ) => {
    // Header
    ctx.textAlign = 'left';
    ctx.font = `bold 22px ${FONT_STACK}`;
    ctx.fillStyle = teamColor;
    ctx.fillText(`${teamName} ${isWinner ? '👑 WHEEL WINNER' : ''}`, startX, 130);

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

      // Username
      ctx.textAlign = 'left';
      ctx.fillStyle = P.text;
      ctx.font = `bold 20px ${FONT_STACK}`;
      const nameStr = item.player.username.length > 13 ? item.player.username.substring(0, 12) + '…' : item.player.username;
      ctx.fillText(nameStr, startX + 78, cardY + 34);

      // New MMR & Tier Name
      const tier = getDivisionTier(item.player.division);
      ctx.font = `600 15px ${FONT_STACK}`;
      ctx.fillStyle = P.textMuted;
      ctx.fillText(`${item.newMmr} MMR (${tier.name})`, startX + 78, cardY + 60);

      // Delta Badge
      const deltaText = item.delta >= 0 ? `+${item.delta} MMR` : `${item.delta} MMR`;
      const deltaColor = item.delta >= 0 ? P.positive : P.negative;
      ctx.textAlign = 'right';
      ctx.font = `bold 18px ${FONT_STACK}`;
      ctx.fillStyle = deltaColor;
      ctx.fillText(deltaText, startX + cardW - 20, cardY + 36);

      // Standing against the division's promotion / relegation line, not a rank change.
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

  await drawTeamColumn('TEAM BLUE 🔵', P.team.blue, blueTeam, 40, wheelWinner === 'BLUE');
  await drawTeamColumn('TEAM ORANGE 🟠', P.team.orange, orangeTeam, 510, wheelWinner === 'ORANGE');

  return canvas.toBuffer('image/png');
}
