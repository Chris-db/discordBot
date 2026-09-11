import { createCanvas } from '@napi-rs/canvas';
import { Client, User } from 'discord.js';
import { Match, getPlayersByIds, getSeriesScore } from '../database/queries';
import { RL_COLORS } from '../ui/embeds';
import { FONT_STACK } from '../utils/fonts';
import { formatMatchDuration } from '../utils/duration';
import { P, alpha, overlay } from '../ui/palette';

/**
 * Generates an 880x420 Match History Canvas Graphic.
 * Displays recent completed matches, winning teams, rosters, and outcome badges.
 */
export async function generateMatchHistoryImage(
  client: Client,
  matches: Match[],
  targetUser?: User
): Promise<Buffer> {
  // Four cards of 75 + 12 from y=100 reach y=436, which the footer at y=424 was already
  // sitting on top of before the series line made the overlap visible.
  const cardW = 800;
  const cardH = 75;
  const cardGap = 12;
  const startX = 40;
  const startY = 100;
  const maxCards = 4;

  const width = 880;
  const shownCards = Math.min(matches.length, maxCards);
  const height =
    matches.length === 0
      ? 440
      : startY + shownCards * (cardH + cardGap) + 34;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // 1. Dark background gradient
  const bgGradient = ctx.createLinearGradient(0, 0, width, height);
  bgGradient.addColorStop(0, P.bgTop); // slate-900
  bgGradient.addColorStop(1, P.bgBottom); // slate-800
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // Top accent line
  ctx.fillStyle = P.accent;
  ctx.fillRect(0, 0, width, 5);

  // 2. Header
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `bold 26px ${FONT_STACK}`;
  const titleText = targetUser
    ? `📜 ${targetUser.username.toUpperCase()}'S MATCH HISTORY`
    : '📜 SERVER 6MANS MATCH HISTORY';
  ctx.fillText(titleText, 40, 50);

  ctx.font = `600 14px ${FONT_STACK}`;
  ctx.fillStyle = P.textMuted;
  ctx.fillText('RECENT COMPLETED GAMES • OFFICIAL RECORD', 40, 75);

  if (matches.length === 0) {
    ctx.textAlign = 'center';
    ctx.fillStyle = P.textFaint;
    ctx.font = `bold 22px ${FONT_STACK}`;
    ctx.fillText('No completed matches found yet!', width / 2, height / 2);
    ctx.font = `16px ${FONT_STACK}`;
    ctx.fillText('Play and report matches for them to appear here.', width / 2, height / 2 + 30);
    return canvas.toBuffer('image/png');
  }

  // 3. Render up to 4 match cards
  const displayMatches = matches.slice(0, maxCards);

  for (let i = 0; i < displayMatches.length; i++) {
    const match = displayMatches[i];
    const cardY = startY + i * (cardH + cardGap);

    const isBlueWin = match.winner === 'BLUE';
    const winColor = isBlueWin ? P.team.blue : P.team.orange;

    // Card background
    ctx.fillStyle = P.history.row;
    ctx.fillRect(startX, cardY, cardW, cardH);
    ctx.strokeStyle = overlay(0.08);
    ctx.lineWidth = 1;
    ctx.strokeRect(startX, cardY, cardW, cardH);

    // Left accent stripe
    ctx.fillStyle = winColor;
    ctx.fillRect(startX, cardY, 6, cardH);

    // Match ID & Date
    ctx.textAlign = 'left';
    ctx.fillStyle = P.text;
    ctx.font = `bold 18px ${FONT_STACK}`;
    ctx.fillText(`MATCH #${match.match_id}`, startX + 25, cardY + 30);

    const dateStr = match.completed_at
      ? new Date(match.completed_at).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        })
      : 'Recent';
    ctx.font = `13px ${FONT_STACK}`;
    ctx.fillStyle = P.textFaint;
    ctx.fillText(`${dateStr}  •  ${match.team_size}v${match.team_size}`, startX + 25, cardY + 52);

    // Winner pill
    const pillText = isBlueWin ? '🔵 BLUE WON' : '🟠 ORANGE WON';
    const pillW = 120;
    const pillH = 26;
    const pillX = startX + 145;
    const pillY = cardY + 24;

    ctx.fillStyle = isBlueWin ? alpha(P.team.blue, 0.15) : alpha(P.team.orange, 0.15);
    ctx.fillRect(pillX, pillY, pillW, pillH);
    ctx.strokeStyle = winColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pillX, pillY, pillW, pillH);

    ctx.textAlign = 'center';
    ctx.font = `bold 12px ${FONT_STACK}`;
    ctx.fillStyle = winColor;
    ctx.fillText(pillText, pillX + pillW / 2, pillY + 17);

    // Series standing as it stood after this game, so a row from the middle of a series
    // reads correctly rather than showing the eventual result.
    if (match.series_id) {
      const { blueWins, orangeWins } = getSeriesScore(match.series_id, match.series_game ?? 1);
      ctx.textAlign = 'left';
      ctx.font = `bold 11px ${FONT_STACK}`;
      ctx.fillStyle = P.history.series;
      ctx.fillText(
        `GAME ${match.series_game ?? 1}  •  🔵 ${blueWins}–${orangeWins} 🟠`,
        pillX,
        cardY + 66
      );
    }

    // Rosters
    const bluePlayers = getPlayersByIds(match.guild_id, match.team_size, match.blue_team);
    const orangePlayers = getPlayersByIds(match.guild_id, match.team_size, match.orange_team);

    const blueNames = bluePlayers.map(p => p.username).join(', ') || 'N/A';
    const orangeNames = orangePlayers.map(p => p.username).join(', ') || 'N/A';

    ctx.textAlign = 'left';
    ctx.font = `bold 13px ${FONT_STACK}`;
    ctx.fillStyle = P.team.blue;
    ctx.fillText(`🔵 Blue:`, startX + 290, cardY + 30);
    ctx.font = `13px ${FONT_STACK}`;
    ctx.fillStyle = P.history.teamText;
    const shortBlue = blueNames.length > 28 ? blueNames.substring(0, 26) + '…' : blueNames;
    ctx.fillText(shortBlue, startX + 345, cardY + 30);

    ctx.font = `bold 13px ${FONT_STACK}`;
    ctx.fillStyle = P.team.orange;
    ctx.fillText(`🟠 Orange:`, startX + 290, cardY + 54);
    ctx.font = `13px ${FONT_STACK}`;
    ctx.fillStyle = P.history.teamText;
    const shortOrange = orangeNames.length > 28 ? orangeNames.substring(0, 26) + '…' : orangeNames;
    ctx.fillText(shortOrange, startX + 360, cardY + 54);

    // Right Player Outcome Badge (if targetUser specified)
    if (targetUser) {
      const isBluePlayer = match.blue_team.includes(targetUser.id);
      const isOrangePlayer = match.orange_team.includes(targetUser.id);
      const isWin = (isBluePlayer && isBlueWin) || (isOrangePlayer && !isBlueWin);

      const resText = isWin ? 'WIN  🏆' : 'LOSS';
      const resColor = isWin ? P.positive : P.negative;

      ctx.textAlign = 'right';
      ctx.font = `bold 20px ${FONT_STACK}`;
      ctx.fillStyle = resColor;
      ctx.fillText(resText, startX + cardW - 25, cardY + 44);
    } else {
      // Deliberately not an MMR delta. completeMatch does stash the base deltas on the row
      // (gamble_status.blueDelta/orangeDelta), but a resolved Wheel of Fate doubles or
      // inverts what players actually received without updating them, so that number would
      // be wrong for exactly the matches people remember. Duration is always true.
      const durationStr = formatMatchDuration(match.started_at, match.completed_at);
      if (durationStr) {
        ctx.textAlign = 'right';
        ctx.font = `bold 16px ${FONT_STACK}`;
        ctx.fillStyle = P.textMuted;
        ctx.fillText(`⏱️ ${durationStr}`, startX + cardW - 25, cardY + 44);
      }
    }
  }

  // Footer text
  ctx.textAlign = 'center';
  ctx.fillStyle = P.textDim;
  ctx.font = `12px ${FONT_STACK}`;
  ctx.fillText('Rocket League 6mans • Match History System', width / 2, height - 16);

  return canvas.toBuffer('image/png');
}
