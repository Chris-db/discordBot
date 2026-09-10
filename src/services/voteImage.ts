import { createCanvas } from '@napi-rs/canvas';
import { Player } from '../database/queries';
import { FONT_STACK } from '../utils/fonts';

export interface VoteCounts {
  captains: number;
  balanced: number;
  random: number;
}

/**
 * Generates an 840x300 Mode Voting Canvas Graphic.
 * Displays 3 interactive mode cards with live vote counters and progress bars.
 */
export async function generateModeVoteImage(
  players: Player[],
  voteCounts: VoteCounts,
  votesRequired: number = 4,
  teamSize: number = 3
): Promise<Buffer> {
  const width = 840;
  const height = 300;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Dark background gradient
  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, '#0f172a'); // slate-900
  bgGradient.addColorStop(1, '#1e293b'); // slate-800
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Top accent bar
  ctx.fillStyle = '#aa00ff';
  ctx.fillRect(0, 0, width, 5);

  // 2. Title & Subtitle
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f8fafc';
  ctx.font = `bold 28px ${FONT_STACK}`;
  ctx.fillText('🗳️ VOTE: TEAM SELECTION MODE', width / 2, 45);

  ctx.font = `600 15px ${FONT_STACK}`;
  ctx.fillStyle = '#94a3b8';
  // The threshold is a majority of this lobby -- 3 of 4, 4 of 6, 5 of 8 -- not a fixed 4.
  ctx.fillText(
    `${votesRequired} matching votes launches the mode  •  Voting closes in 30s`,
    width / 2,
    72
  );

  // 3. Draw 3 Mode Cards
  const drawModeCard = (
    title: string,
    icon: string,
    desc: string,
    votes: number,
    x: number,
    colorHex: string
  ) => {
    const cardW = 240;
    const cardH = 180;
    const cardY = 95;

    // Background
    ctx.fillStyle = votes > 0 ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.03)';
    ctx.fillRect(x, cardY, cardW, cardH);
    ctx.strokeStyle = votes > 0 ? colorHex : '#334155';
    ctx.lineWidth = votes > 0 ? 2 : 1;
    ctx.strokeRect(x, cardY, cardW, cardH);

    // Top Stripe
    ctx.fillStyle = colorHex;
    ctx.fillRect(x, cardY, cardW, 4);

    // Mode Icon
    ctx.textAlign = 'center';
    ctx.fillStyle = colorHex;
    ctx.font = `bold 36px ${FONT_STACK}`;
    ctx.fillText(icon, x + cardW / 2, cardY + 48);

    // Title
    ctx.fillStyle = '#f8fafc';
    ctx.font = `bold 18px ${FONT_STACK}`;
    ctx.fillText(title, x + cardW / 2, cardY + 80);

    // Description
    ctx.fillStyle = '#94a3b8';
    ctx.font = `13px ${FONT_STACK}`;
    ctx.fillText(desc, x + cardW / 2, cardY + 105);

    // Vote Progress Bar toward the threshold
    const progress = Math.min(1, votes / Math.max(1, votesRequired));
    const barX = x + 25;
    const barY = cardY + 125;
    const barW = cardW - 50;
    const barH = 14;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(barX, barY, barW, barH);

    if (progress > 0) {
      ctx.fillStyle = colorHex;
      ctx.fillRect(barX, barY, Math.round(barW * progress), barH);
    }

    // Vote count badge text
    ctx.font = `bold 16px ${FONT_STACK}`;
    ctx.fillStyle = votes > 0 ? colorHex : '#64748b';
    ctx.fillText(`${votes} / ${votesRequired} VOTES`, x + cardW / 2, cardY + 163);
  };

  drawModeCard('CAPTAINS DRAFT', '👑', 'Captains Snake Draft', voteCounts.captains, 40, '#ffd700');
  drawModeCard('BALANCED MMR', '⚖️', 'Fair auto-balanced teams', voteCounts.balanced, 300, '#00b0ff');
  drawModeCard(
    'RANDOM TEAMS',
    '🎲',
    `Completely randomized ${teamSize}v${teamSize}`,
    voteCounts.random,
    560,
    '#00e676'
  );

  return canvas.toBuffer('image/png');
}
