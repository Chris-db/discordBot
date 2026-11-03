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
 * Three full turns plus the landing offset, so the spin is never visibly the same
 * twice; the stop lands in the middle 80% of the slice, never on a boundary where the
 * pointer would look undecided.
 */
export function landingAngleFor(winner: 'BLUE' | 'ORANGE', rng: () => number = Math.random): number {
  const tau = Math.PI * 2;
  const candidates = Array.from({ length: WHEEL_SEGMENTS }, (_, i) => i).filter(i => segmentTeam(i) === winner);
  const segment = candidates[Math.floor(rng() * candidates.length)];
  const local = (segment + 0.1 + 0.8 * rng()) * SEGMENT_ARC;
  const rest = (tau - local) % tau;
  const turns = 3;
  return turns * tau + rest;
}

export interface WheelStyle {
  /** Two short lines drawn in the hub; omitted for very small wheels. */
  hubLines?: [string, string];
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
  for (let i = 0; i < WHEEL_SEGMENTS; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, r - rim / 2, i * SEGMENT_ARC, (i + 1) * SEGMENT_ARC);
    ctx.closePath();
    ctx.fillStyle = segmentTeam(i) === 'BLUE' ? P.team.blue : P.team.orange;
    ctx.fill();
  }
  // Dark seams between slices so adjacent colours read as separate.
  ctx.strokeStyle = P.gamble.stoneTop;
  ctx.lineWidth = Math.max(1, r * 0.012);
  for (let i = 0; i < WHEEL_SEGMENTS; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(i * SEGMENT_ARC) * r, Math.sin(i * SEGMENT_ARC) * r);
    ctx.stroke();
  }
  ctx.restore();

  // Rim
  ctx.beginPath();
  ctx.arc(0, 0, r - rim / 2, 0, Math.PI * 2);
  ctx.strokeStyle = P.gold;
  ctx.lineWidth = rim;
  ctx.stroke();

  // Hub
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

  // Pointer: a gold wedge hanging over the rim at twelve o'clock, outlined in the
  // background colour so it separates from whichever slice it is over.
  {
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

export const SPIN_GIF_SIZE = 360;
/** Chromium plays GIF frames at 20 ms or slower; 45 ms (22 fps) reads as a wheel, not a flicker. */
const FRAME_DELAY_MS = 45;
/**
 * How long the landed wheel holds, and in how many frames. The GIF is written to play
 * once, but a player that loops regardless must not restart the spin before the caller
 * has collapsed the message -- and the viewer's copy starts later than the bot's upload
 * finishes, by however long the download took. The hold is a run of 1×1 transparent
 * frames that leave the landed frame in place, so it costs a few bytes a frame and never
 * depends on a player honouring one very long frame delay.
 */
const HOLD_MS = 15_000;
const HOLD_FRAME_MS = 250;
/**
 * The most the wheel may turn between two frames: under half a slice. Eight identical
 * slices stepping more than that per frame read as a slower wheel, or one going backwards
 * (the wagon-wheel effect) -- and the earlier motion-blur attempt, which smeared the
 * slices to hide that, blended blue over orange into olive.
 */
const MAX_STEP = SEGMENT_ARC * 0.45;
/**
 * The cover is the GIF's first frame. A viewer with Discord's GIF autoplay off sees only
 * that frame, still, until they tap it -- so it says the wheel plays. Anyone autoplaying
 * sees it for 20 ms, the shortest delay Chromium honours.
 */
const COVER_DELAY_MS = 20;
/** The fraction of the spin at full speed before the wheel starts to slow. */
const CRUISE = 0.3;

/**
 * Angle as a fraction of the total, for t in [0, 1]: flat out for the cruise, then a
 * cubic ease down to a stop. Its steepest slope is `PEAK_SLOPE`, at the start.
 */
const PEAK_SLOPE = 1 / (CRUISE + (1 - CRUISE) / 3);
export function spinProfile(t: number): number {
  if (t <= CRUISE) return PEAK_SLOPE * t;
  const u = (t - CRUISE) / (1 - CRUISE);
  return PEAK_SLOPE * (CRUISE + ((1 - CRUISE) * (1 - Math.pow(1 - u, 3))) / 3);
}

/** How many frames a spin of `landingAngle` needs to keep every step under MAX_STEP. */
export function spinFrameCount(landingAngle: number): number {
  return Math.ceil((landingAngle * PEAK_SLOPE) / MAX_STEP) + 1;
}

/**
 * A "▶ Tap to spin" pill centred on (cx, cy), in the wheel's own colours so the palette
 * built from the landed frame still covers it. The play triangle is a path, not a glyph:
 * the emoji font would draw ▶ in a blue the palette does not hold.
 */
function drawCoverLabel(ctx: SKRSContext2D, cx: number, cy: number): void {
  const label = 'Tap to spin';
  const h = 44;
  const icon = 14;
  const gap = 10;
  ctx.font = `bold 20px ${FONT_STACK}`;
  const textW = ctx.measureText(label).width;
  const w = 24 + icon + gap + textW + 24;
  const left = cx - w / 2;

  ctx.beginPath();
  ctx.roundRect(left, cy - h / 2, w, h, h / 2);
  ctx.fillStyle = P.gamble.stoneTop;
  ctx.fill();
  ctx.strokeStyle = P.gold;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  const ix = left + 24;
  ctx.beginPath();
  ctx.moveTo(ix, cy - icon / 2);
  ctx.lineTo(ix + icon, cy);
  ctx.lineTo(ix, cy + icon / 2);
  ctx.closePath();
  ctx.fillStyle = P.gold;
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = P.text;
  ctx.fillText(label, ix + icon + gap, cy + 1);
  ctx.textBaseline = 'alphabetic';
}

export interface WheelSpin {
  buffer: Buffer;
  /** Play time from the first frame to the wheel coming to rest. */
  landedAfterMs: number;
  /** Play time of the whole file, landed hold included. */
  durationMs: number;
  /** Where the wheel stopped, for the frozen copy on the result card. */
  landingAngle: number;
}

/**
 * Renders the spin as an animated GIF that ends with the pointer on the winner's colour.
 *
 * Every frame is sharp; the sense of speed comes from many close frames rather than blur.
 * The palette is built once from the last frame -- the wheel is a dozen flat colours plus
 * their anti-aliased edges, the same in every frame -- and applied to all of them.
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
  const frameCount = spinFrameCount(landingAngle);
  const cx = size / 2;
  const cy = size / 2 + 10;
  const r = size * 0.42;
  const hubLines: [string, string] = ['DOUBLE OR NOTHING', `MATCH #${matchNumber}`];

  ctx.fillStyle = P.gamble.stoneTop;
  ctx.fillRect(0, 0, size, size);
  drawWheel(ctx, cx, cy, r, 0, { hubLines });
  drawCoverLabel(ctx, cx, cy + r * 0.62);
  const cover = new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer);

  const frames: Uint8Array[] = [];
  for (let f = 0; f < frameCount; f++) {
    const angle = landingAngle * spinProfile(f / (frameCount - 1));
    ctx.fillStyle = P.gamble.stoneTop;
    ctx.fillRect(0, 0, size, size);
    drawWheel(ctx, cx, cy, r, angle, { hubLines });
    frames.push(new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer));
  }

  const palette = quantize(frames[frames.length - 1], 256, { format: 'rgb444' });

  const gif = GIFEncoder();
  gif.writeFrame(applyPalette(cover, palette, 'rgb444'), size, size, {
    palette,
    delay: COVER_DELAY_MS,
    // Leave each frame in place for the next to draw over.
    dispose: 1,
    // Once: the wheel stays landed. Discord may loop anyway; see HOLD_MS.
    repeat: -1,
  });
  for (const rgba of frames) {
    gif.writeFrame(applyPalette(rgba, palette, 'rgb444'), size, size, {
      delay: FRAME_DELAY_MS,
      dispose: 1,
    });
  }
  // The hold: one transparent pixel over the landed wheel, again and again.
  const holdFrames = Math.ceil(HOLD_MS / HOLD_FRAME_MS);
  const holdPixel = new Uint8Array([0]);
  for (let i = 0; i < holdFrames; i++) {
    gif.writeFrame(holdPixel, 1, 1, {
      delay: HOLD_FRAME_MS,
      transparent: true,
      transparentIndex: 0,
      dispose: 1,
    });
  }
  gif.finish();

  return {
    buffer: Buffer.from(gif.bytes()),
    landedAfterMs: COVER_DELAY_MS + (frameCount - 1) * FRAME_DELAY_MS,
    durationMs: COVER_DELAY_MS + (frameCount - 1) * FRAME_DELAY_MS + holdFrames * HOLD_FRAME_MS,
    landingAngle,
  };
}
