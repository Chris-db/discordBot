import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { FONT_STACK } from '../utils/fonts';
import { P } from '../ui/palette';

/**
 * The Double or Nothing wheel: eight slices alternating blue and orange, a gold rim and
 * pointer, and a hub naming the match. One renderer draws it everywhere -- the spin GIF
 * that replaces the consensus card, and the frozen copy in the result card's header --
 * so the two images read as one sequence.
 *
 * Angles are in radians, clockwise, with 0 putting slice 0's leading edge under the
 * pointer at twelve o'clock. `landingAngleFor` and `segmentUnderPointer` are the only
 * maths the outcome depends on, and they are exported so a test can prove the wheel lands
 * on the colour the coin flip chose -- the GIF is rendered after the flip, never before.
 */

export const WHEEL_SEGMENTS = 8;
const SEGMENT_ARC = (Math.PI * 2) / WHEEL_SEGMENTS;

/** Even slices are blue, odd orange. */
export function segmentTeam(index: number): 'BLUE' | 'ORANGE' {
  return index % 2 === 0 ? 'BLUE' : 'ORANGE';
}

/** Which slice sits under the pointer when the wheel has turned `angle` clockwise. */
export function segmentUnderPointer(angle: number): number {
  const tau = Math.PI * 2;
  const local = ((-angle % tau) + tau) % tau;
  return Math.floor(local / SEGMENT_ARC) % WHEEL_SEGMENTS;
}

/**
 * The total rotation for a spin that ends on a slice of the winner's colour.
 *
 * Four to five full turns plus the landing offset, so the spin is never visibly the same
 * twice; the stop lands in the middle 80% of the slice, never on a boundary where the
 * pointer would look undecided.
 */
export function landingAngleFor(winner: 'BLUE' | 'ORANGE', rng: () => number = Math.random): number {
  const tau = Math.PI * 2;
  const candidates = Array.from({ length: WHEEL_SEGMENTS }, (_, i) => i).filter(i => segmentTeam(i) === winner);
  const segment = candidates[Math.floor(rng() * candidates.length)];
  const local = (segment + 0.1 + 0.8 * rng()) * SEGMENT_ARC;
  const rest = (tau - local) % tau;
  const turns = 4 + Math.floor(rng() * 2);
  return turns * tau + rest;
}

/**
 * Which layers to draw; every flag defaults to true. The GIF draws two passes per frame:
 * the slices alone, smeared, then everything that does not move -- seams, rim, hub,
 * pointer -- once and sharp on top.
 */
export interface WheelStyle {
  /** Two short lines drawn in the hub; omitted for very small wheels. */
  hubLines?: [string, string];
  slices?: boolean;
  seams?: boolean;
  rim?: boolean;
  hub?: boolean;
  pointer?: boolean;
}

/**
 * Draws the wheel with its centre at (cx, cy) and outer radius r, turned `angle` clockwise.
 */
export function drawWheel(
  ctx: SKRSContext2D,
  cx: number,
  cy: number,
  r: number,
  angle: number,
  style: WheelStyle = {}
): void {
  const rim = Math.max(2, r * 0.045);
  const hubR = r * 0.34;

  ctx.save();
  ctx.translate(cx, cy);

  // Canvas measures from three o'clock, the wheel from twelve.
  ctx.save();
  ctx.rotate(angle - Math.PI / 2);
  if (style.slices !== false) {
    for (let i = 0; i < WHEEL_SEGMENTS; i++) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r - rim / 2, i * SEGMENT_ARC, (i + 1) * SEGMENT_ARC);
      ctx.closePath();
      ctx.fillStyle = segmentTeam(i) === 'BLUE' ? P.team.blue : P.team.orange;
      ctx.fill();
    }
  }
  if (style.seams !== false) {
    // Dark seams between slices so adjacent colours read as separate.
    ctx.strokeStyle = P.gamble.stoneTop;
    ctx.lineWidth = Math.max(1, r * 0.012);
    for (let i = 0; i < WHEEL_SEGMENTS; i++) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(i * SEGMENT_ARC) * r, Math.sin(i * SEGMENT_ARC) * r);
      ctx.stroke();
    }
  }
  ctx.restore();

  if (style.rim !== false) {
    ctx.beginPath();
    ctx.arc(0, 0, r - rim / 2, 0, Math.PI * 2);
    ctx.strokeStyle = P.gold;
    ctx.lineWidth = rim;
    ctx.stroke();
  }

  if (style.hub !== false) {
    ctx.beginPath();
    ctx.arc(0, 0, hubR, 0, Math.PI * 2);
    ctx.fillStyle = P.gamble.stoneTop;
    ctx.fill();
    ctx.strokeStyle = P.gold;
    ctx.lineWidth = Math.max(1.5, rim * 0.7);
    ctx.stroke();

    if (style.hubLines) {
      const [top, bottom] = style.hubLines;
      ctx.textAlign = 'center';
      ctx.fillStyle = P.text;
      ctx.font = `bold ${Math.round(hubR * 0.26)}px ${FONT_STACK}`;
      ctx.fillText(top, 0, -hubR * 0.08);
      ctx.fillStyle = P.textMuted;
      ctx.font = `600 ${Math.round(hubR * 0.24)}px ${FONT_STACK}`;
      ctx.fillText(bottom, 0, hubR * 0.3);
    }
  }

  // Pointer: a gold wedge hanging over the rim at twelve o'clock, outlined in the
  // background colour so it separates from whichever slice it is over.
  if (style.pointer !== false) {
    const w = r * 0.16;
    const h = r * 0.22;
    ctx.beginPath();
    ctx.moveTo(-w / 2, -r - h * 0.45);
    ctx.lineTo(w / 2, -r - h * 0.45);
    ctx.lineTo(0, -r + h * 0.55);
    ctx.closePath();
    ctx.fillStyle = P.gold;
    ctx.fill();
    ctx.strokeStyle = P.gamble.stoneTop;
    ctx.lineWidth = Math.max(1, r * 0.015);
    ctx.stroke();
  }

  ctx.restore();
}

/** Eases out hard: most of the turning happens in the first third, then a long settle. */
function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - t, 4);
}

export const SPIN_GIF_SIZE = 420;
export const SPIN_FRAMES = 36;
const FRAME_DELAY_MS = 90;
/** The landed wheel holds before Discord loops the GIF back to the start. */
const HOLD_LAST_MS = 1200;

export interface WheelSpin {
  buffer: Buffer;
  /** Play time of one loop; the caller waits this long before posting the result. */
  durationMs: number;
  /** Where the wheel stopped, for the frozen copy on the result card. */
  landingAngle: number;
}

/**
 * Renders the spin as an animated GIF that ends with the pointer on the winner's colour.
 *
 * Fast frames are drawn as a stack of sub-steps at reduced alpha, which smears the slices
 * into a ring the way a real wheel blurs -- and avoids eight slices at one rotation per
 * few frames strobing into an apparent slow backwards turn. The hub and pointer do not
 * move, so they are drawn once per frame, on top, sharp.
 *
 * The palette is built once from the sharp last frame and the most blurred frame together,
 * then applied to every frame: the wheel has a dozen colours plus blends, and quantising
 * 36 frames separately would cost seconds on the Pi for no visible gain.
 */
export function generateWheelSpinGif(
  /** The per-server display number, not the database match_id. */
  matchNumber: number,
  winner: 'BLUE' | 'ORANGE',
  rng: () => number = Math.random
): WheelSpin {
  const size = SPIN_GIF_SIZE;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const landingAngle = landingAngleFor(winner, rng);
  const cx = size / 2;
  const cy = size / 2 + 10;
  const r = size * 0.42;
  const hubLines: [string, string] = ['DOUBLE OR NOTHING', `MATCH #${matchNumber}`];

  const frames: Uint8Array[] = [];
  let blurriest: { delta: number; data: Uint8Array } | null = null;
  let previous = 0;

  for (let f = 0; f < SPIN_FRAMES; f++) {
    const t = f / (SPIN_FRAMES - 1);
    const angle = landingAngle * easeOutQuart(t);
    const delta = angle - previous;

    ctx.fillStyle = P.gamble.stoneTop;
    ctx.fillRect(0, 0, size, size);

    // Sub-steps only when the wheel moved more than a sliver since the last frame.
    const steps = delta > 0.12 ? Math.min(6, Math.ceil(delta / 0.12)) : 1;
    ctx.globalAlpha = 1 / steps;
    for (let s = 0; s < steps; s++) {
      const a = previous + (delta * (s + 1)) / steps;
      drawWheel(ctx, cx, cy, r, a, { seams: false, rim: false, hub: false, pointer: false });
    }
    ctx.globalAlpha = 1;
    // Seams are only drawn once the wheel is slow enough for slices to be distinct.
    drawWheel(ctx, cx, cy, r, angle, { slices: false, seams: steps === 1, hubLines });

    const rgba = new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer);
    frames.push(rgba);
    if (steps > 1 && (!blurriest || delta > blurriest.delta)) blurriest = { delta, data: rgba };
    previous = angle;
  }

  const last = frames[frames.length - 1];
  const sample = blurriest ? concat(last, blurriest.data) : last;
  const palette = quantize(sample, 256, { format: 'rgb444' });

  const gif = GIFEncoder();
  frames.forEach((rgba, i) => {
    const index = applyPalette(rgba, palette, 'rgb444');
    const isLast = i === frames.length - 1;
    gif.writeFrame(index, size, size, {
      palette: i === 0 ? palette : undefined,
      delay: isLast ? HOLD_LAST_MS : FRAME_DELAY_MS,
      repeat: 0,
    });
  });
  gif.finish();

  return {
    buffer: Buffer.from(gif.bytes()),
    durationMs: (SPIN_FRAMES - 1) * FRAME_DELAY_MS + HOLD_LAST_MS,
    landingAngle,
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
