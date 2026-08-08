import { createCanvas } from '@napi-rs/canvas';
import { Client, User } from 'discord.js';
import { Match, getPlayersByIds } from '../database/queries';
import { RL_COLORS } from '../ui/embeds';

/**
 * Generates an 880x420 Match History Canvas Graphic.
 * Displays recent completed matches, winning teams, rosters, and outcome badges.
 */
export async function generateMatchHistoryImage(
  client: Client,
  matches: Match[],
  targetUser?: User
): Promise<Buffer> {
  const width = 880;
  const height = 440;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Dark background gradient
  const bgGradient = ctx.createLinearGradient(0, 0, width, height);
  bgGradient.addColorStop(0, '#0f172a'); // slate-900
  bgGradient.addColorStop(1, '#1e293b'); // slate-800
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Top accent line
  ctx.fillStyle = '#00b0ff';
  ctx.fillRect(0, 0, width, 5);

  // 2. Header
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 26px sans-serif';
  const titleText = targetUser
    ? `📜 ${targetUser.username.toUpperCase()}'S MATCH HISTORY`
    : '📜 SERVER 6MANS MATCH HISTORY';
  ctx.fillText(titleText, 40, 50);

  ctx.font = '600 14px sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('RECENT COMPLETED 3v3 GAMES • OFFICIAL RECORD', 40, 75);

  if (matches.length === 0) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#64748b';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('No completed matches found yet!', width / 2, height / 2);
    ctx.font = '16px sans-serif';
    ctx.fillText('Play and report matches for them to appear here.', width / 2, height / 2 + 30);
    return canvas.toBuffer('image/png');
  }

  // 3. Render up to 4 match cards
  const cardW = 800;
  const cardH = 75;
  const startX = 40;
  const startY = 100;

  const displayMatches = matches.slice(0, 4);

  for (let i = 0; i < displayMatches.length; i++) {
    const match = displayMatches[i];
    const cardY = startY + i * (cardH + 12);

    const isBlueWin = match.winner === 'BLUE';
    const winColor = isBlueWin ? '#00b0ff' : '#ff9100';

    // Card background
    ctx.fillStyle = 'rgba(30, 41, 59, 0.8)';
    ctx.fillRect(startX, cardY, cardW, cardH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(startX, cardY, cardW, cardH);

    // Left accent stripe
    ctx.fillStyle = winColor;
    ctx.fillRect(startX, cardY, 6, cardH);

    // Match ID & Date
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`MATCH #${match.match_id}`, startX + 25, cardY + 30);

    const dateStr = match.completed_at
      ? new Date(match.completed_at).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        })
      : 'Recent';
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText(dateStr, startX + 25, cardY + 52);

    // Winner pill
    const pillText = isBlueWin ? '🔵 BLUE WON' : '🟠 ORANGE WON';
    const pillW = 120;
    const pillH = 26;
    const pillX = startX + 145;
    const pillY = cardY + 24;

    ctx.fillStyle = isBlueWin ? 'rgba(0, 176, 255, 0.15)' : 'rgba(255, 145, 0, 0.15)';
    ctx.fillRect(pillX, pillY, pillW, pillH);
    ctx.strokeStyle = winColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pillX, pillY, pillW, pillH);

    ctx.textAlign = 'center';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = winColor;
    ctx.fillText(pillText, pillX + pillW / 2, pillY + 17);

    // Rosters
    const bluePlayers = getPlayersByIds(match.guild_id, match.blue_team);
    const orangePlayers = getPlayersByIds(match.guild_id, match.orange_team);

    const blueNames = bluePlayers.map(p => p.username).join(', ') || 'N/A';
    const orangeNames = orangePlayers.map(p => p.username).join(', ') || 'N/A';

    ctx.textAlign = 'left';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#00b0ff';
    ctx.fillText(`🔵 Blue:`, startX + 290, cardY + 30);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#cbd5e1';
    const shortBlue = blueNames.length > 28 ? blueNames.substring(0, 26) + '…' : blueNames;
    ctx.fillText(shortBlue, startX + 345, cardY + 30);

    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#ff9100';
    ctx.fillText(`🟠 Orange:`, startX + 290, cardY + 54);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#cbd5e1';
    const shortOrange = orangeNames.length > 28 ? orangeNames.substring(0, 26) + '…' : orangeNames;
    ctx.fillText(shortOrange, startX + 360, cardY + 54);

    // Right Player Outcome Badge (if targetUser specified)
    if (targetUser) {
      const isBluePlayer = match.blue_team.includes(targetUser.id);
      const isOrangePlayer = match.orange_team.includes(targetUser.id);
      const isWin = (isBluePlayer && isBlueWin) || (isOrangePlayer && !isBlueWin);

      const resText = isWin ? 'WIN  🏆' : 'LOSS';
      const resColor = isWin ? '#00e676' : '#ff1744';

      ctx.textAlign = 'right';
      ctx.font = 'bold 20px sans-serif';
      ctx.fillStyle = resColor;
      ctx.fillText(resText, startX + cardW - 25, cardY + 44);
    } else {
      ctx.textAlign = 'right';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(isBlueWin ? '🔵 +15 MMR' : '🟠 +15 MMR', startX + cardW - 25, cardY + 44);
    }
  }

  // Footer text
  ctx.textAlign = 'center';
  ctx.fillStyle = '#475569';
  ctx.font = '12px sans-serif';
  ctx.fillText('Rocket League 6mans • Match History System', width / 2, height - 16);

  return canvas.toBuffer('image/png');
}
