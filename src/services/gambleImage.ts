import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { Player } from '../database/queries';
import { drawArrow } from '../ui/glyphs';
import { drawWheel, landingAngleFor } from './wheelImage';
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
 * Generates the 960px-wide gamble result card.
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
  orangeTeam: GamblePlayerResult[],
  /**
   * Where the spin GIF stopped, so the header's frozen wheel matches what everyone just
   * watched. Absent (the GIF failed to render) it is any angle on the winner's colour.
   */
  wheelAngle: number = landingAngleFor(wheelWinner)
): Promise<Buffer> {
  // Cards start at y=170 with a 92px pitch, so the canvas has to grow with the roster:
  // four a side would run off the old fixed 420px.
  const rosterRows = Math.max(blueTeam.length, orangeTeam.length);
  const width = 960;
  const height = 170 + rosterRows * 92 + 10;
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

  // 2. The wheel, frozen where the spin GIF left it, with the title beside it. The header
  // used to be centred text alone; the wheel ties the card to the spin that preceded it.
  drawWheel(ctx, 90, 82, 48, wheelAngle);

  const textX = 150;
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `bold 32px ${FONT_STACK}`;
  const titleText = resultType === 'INVERTED' ? '💥  RESULT INVERTED!' : '🔥  RESULT DOUBLED!';
  ctx.fillText(titleText, textX, 72);

  ctx.font = `bold 16px ${FONT_STACK}`;
  ctx.fillStyle = resultType === 'INVERTED' ? P.gamble.invertedText : P.gamble.doubledText;
  const subText =
    resultType === 'INVERTED'
      ? `MATCH #${matchNumber}  •  TEAM ${wheelWinner} WON THE 50/50 & STOLE THE MMR!`
      : `MATCH #${matchNumber}  •  TEAM ${wheelWinner} WON THE 50/50 & DOUBLED THEIR MMR!`;
  ctx.fillText(subText, textX, 100);

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
    ctx.fillText(`${teamName} ${isWinner ? '👑 WHEEL WINNER' : ''}`, startX, 150);

    const cardW = 410;
    const cardH = 80;
    for (let i = 0; i < roster.length; i++) {
      const item = roster[i];
      const cardY = 170 + i * (cardH + 12);

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
        // An arrow under the delta, right-aligned with it: up for the promotion zone,
        // down for the relegation zone. Replaced a 140px labelled pill at Chris's request.
        drawArrow(ctx, startX + cardW - 20 - 14, cardY + 45, 14, 20, zone.direction, zone.color);
      }
    }
  };

  await drawTeamColumn('TEAM BLUE 🔵', P.team.blue, blueTeam, 40, wheelWinner === 'BLUE');
  await drawTeamColumn('TEAM ORANGE 🟠', P.team.orange, orangeTeam, 510, wheelWinner === 'ORANGE');

  return canvas.toBuffer('image/png');
}
