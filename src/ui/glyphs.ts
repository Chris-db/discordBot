import type { SKRSContext2D } from '@napi-rs/canvas';

/**
 * Small vector marks drawn straight onto a card. Vector rather than emoji so they take
 * the theme's colours and never come out as a coloured blob from the emoji font.
 */

/**
 * A solid arrow inside a `w` × `h` box whose top-left is (x, y). Up for promotion zone,
 * down for relegation zone. Proportions: the head is 45% of the height and spans the
 * full width; the shaft is the middle 40% of the width.
 */
export function drawArrow(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  direction: 'up' | 'down',
  color: string
): void {
  const headH = h * 0.45;
  const shaftW = w * 0.4;
  const cx = x + w / 2;
  const sx = cx - shaftW / 2;

  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  if (direction === 'up') {
    ctx.moveTo(cx, y);
    ctx.lineTo(x + w, y + headH);
    ctx.lineTo(sx + shaftW, y + headH);
    ctx.lineTo(sx + shaftW, y + h);
    ctx.lineTo(sx, y + h);
    ctx.lineTo(sx, y + headH);
    ctx.lineTo(x, y + headH);
  } else {
    ctx.moveTo(cx, y + h);
    ctx.lineTo(x + w, y + h - headH);
    ctx.lineTo(sx + shaftW, y + h - headH);
    ctx.lineTo(sx + shaftW, y);
    ctx.lineTo(sx, y);
    ctx.lineTo(sx, y + h - headH);
    ctx.lineTo(x, y + h - headH);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
