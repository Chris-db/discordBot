import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Client } from 'discord.js';
import { Player } from '../database/queries';
import { getDivisionTier } from './mmrService';
import { getCachedAvatarImage } from '../utils/avatarCache';
import { FONT_STACK } from '../utils/fonts';
import { P } from '../ui/palette';

/**
 * Generates the Captains Draft Visual Scoreboard.
 * Displays Blue Team on the left, Orange Team on the right, and the Available Draft Pool in the center.
 *
 * Height is driven by the tallest of the three columns. The pool is the tall one -- it
 * starts at 2*teamSize - 2 players, which is 4 even at 3v3, so the old fixed 420px canvas
 * was already clipping the bottom card on the first pick of every captains draft.
 */
export async function generateCaptainsDraftImage(
  client: Client,
  blueCaptain: Player,
  orangeCaptain: Player,
  blueTeam: Player[],
  orangeTeam: Player[],
  remaining: Player[],
  turn: 'BLUE' | 'ORANGE',
  pickNumber: number,
  teamSize: number
): Promise<Buffer> {
  const rowPitch = 85;
  const cardH = 70;
  const gridTop = 130;

  const maxRows = Math.max(teamSize, remaining.length);
  const width = 880;
  const height = gridTop + maxRows * rowPitch - (rowPitch - cardH) + 20;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Dark background
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, P.bgTop);
  bgGradient.addColorStop(1, P.bgBottom);
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Top accent bar by current turn
  const turnColor = turn === 'BLUE' ? P.team.blue : P.team.orange;
  ctx.fillStyle = turnColor;
  ctx.fillRect(0, 0, width, 5);

  // 2. Title & Turn Header
  ctx.textAlign = 'center';
  ctx.fillStyle = P.text;
  ctx.font = `bold 28px ${FONT_STACK}`;
  ctx.fillText(`👑 CAPTAINS ${teamSize}V${teamSize} DRAFT IN PROGRESS`, width / 2, 45);

  ctx.font = `bold 16px ${FONT_STACK}`;
  ctx.fillStyle = turnColor;
  const captainName = turn === 'BLUE' ? blueCaptain.username : orangeCaptain.username;
  ctx.fillText(`CURRENT TURN: ${turn === 'BLUE' ? '🔵 BLUE' : '🟠 ORANGE'} CAPTAIN (${captainName})  •  PICK #${pickNumber}`, width / 2, 75);

  // 3. Helper to draw a player card
  const drawPlayerCard = async (
    player: Player,
    x: number,
    y: number,
    w: number,
    h: number,
    borderColor: string,
    label?: string
  ) => {
    ctx.fillStyle = P.card;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);

    // Avatar
    const radius = 20;
    const ax = x + 30;
    const ay = y + h / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax, ay, radius, 0, Math.PI * 2);
    ctx.clip();

    try {
      const img = await getCachedAvatarImage(client, player.discord_id, 128);
      if (img) {
        ctx.drawImage(img, ax - radius, ay - radius, radius * 2, radius * 2);
      } else {
        throw new Error('Avatar fallback');
      }
    } catch {
      ctx.fillStyle = P.surface;
      ctx.fillRect(ax - radius, ay - radius, radius * 2, radius * 2);
      ctx.fillStyle = P.white;
      ctx.font = `bold 14px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.fillText(player.username.charAt(0).toUpperCase() || '?', ax, ay + 5);
    }
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.fillStyle = P.text;
    ctx.font = `bold 16px ${FONT_STACK}`;
    const shortName = player.username.length > 10 ? player.username.substring(0, 9) + '…' : player.username;
    ctx.fillText(shortName, x + 60, y + 26);

    ctx.font = `600 13px ${FONT_STACK}`;
    ctx.fillStyle = P.textMuted;
    const tier = getDivisionTier(player.division);
    ctx.fillText(`${player.mmr} MMR (${tier.name})`, x + 60, y + 46);

    if (label) {
      ctx.textAlign = 'right';
      ctx.font = `bold 12px ${FONT_STACK}`;
      ctx.fillStyle = borderColor;
      ctx.fillText(label, x + w - 10, y + 20);
    }
  };

  // 4. Left Column: Blue Team (x=30, w=250)
  ctx.textAlign = 'left';
  ctx.font = `bold 18px ${FONT_STACK}`;
  ctx.fillStyle = P.team.blue;
  ctx.fillText('🔵 TEAM BLUE', 30, 115);

  const fullBlue = [blueCaptain, ...blueTeam.filter(p => p.discord_id !== blueCaptain.discord_id)];
  for (let i = 0; i < teamSize; i++) {
    const p = fullBlue[i];
    const cardY = gridTop + i * rowPitch;
    if (p) {
      await drawPlayerCard(p, 30, cardY, 250, cardH, P.team.blue, i === 0 ? '👑 CAPTAIN' : undefined);
    } else {
      ctx.fillStyle = P.cardEmpty;
      ctx.fillRect(30, cardY, 250, cardH);
      ctx.strokeStyle = P.surface;
      ctx.strokeRect(30, cardY, 250, cardH);
      ctx.textAlign = 'center';
      ctx.font = `600 14px ${FONT_STACK}`;
      ctx.fillStyle = P.textDim;
      ctx.fillText('[ EMPTY SLOT ]', 30 + 125, cardY + 40);
    }
  }

  // 5. Right Column: Orange Team (x=600, w=250)
  ctx.textAlign = 'left';
  ctx.font = `bold 18px ${FONT_STACK}`;
  ctx.fillStyle = P.team.orange;
  ctx.fillText('🟠 TEAM ORANGE', 600, 115);

  const fullOrange = [orangeCaptain, ...orangeTeam.filter(p => p.discord_id !== orangeCaptain.discord_id)];
  for (let i = 0; i < teamSize; i++) {
    const p = fullOrange[i];
    const cardY = gridTop + i * rowPitch;
    if (p) {
      await drawPlayerCard(p, 600, cardY, 250, cardH, P.team.orange, i === 0 ? '👑 CAPTAIN' : undefined);
    } else {
      ctx.fillStyle = P.cardEmpty;
      ctx.fillRect(600, cardY, 250, cardH);
      ctx.strokeStyle = P.surface;
      ctx.strokeRect(600, cardY, 250, cardH);
      ctx.textAlign = 'center';
      ctx.font = `600 14px ${FONT_STACK}`;
      ctx.fillStyle = P.textDim;
      ctx.fillText('[ EMPTY SLOT ]', 600 + 125, cardY + 40);
    }
  }

  // 6. Center Column: Available Pool (x=305, w=270)
  ctx.textAlign = 'center';
  ctx.font = `bold 18px ${FONT_STACK}`;
  ctx.fillStyle = P.text;
  ctx.fillText('📋 AVAILABLE DRAFT POOL', 440, 115);

  for (let i = 0; i < remaining.length; i++) {
    const p = remaining[i];
    const cardY = gridTop + i * rowPitch;
    await drawPlayerCard(p, 305, cardY, 270, cardH, P.purple, `AVAILABLE`);
  }

  return canvas.toBuffer('image/png');
}
