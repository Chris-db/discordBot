import { describe, it, expect } from 'vitest';
import {
  landingAngleFor,
  segmentUnderPointer,
  segmentTeam,
  generateWheelSpinGif,
  SPIN_FRAMES,
  SPIN_GIF_SIZE,
  WHEEL_SEGMENTS,
} from '../src/services/wheelImage';

/** A small deterministic generator so a failure names the seed that produced it. */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('wheel maths', () => {
  it('alternates blue and orange around the wheel', () => {
    for (let i = 0; i < WHEEL_SEGMENTS; i++) {
      expect(segmentTeam(i)).toBe(i % 2 === 0 ? 'BLUE' : 'ORANGE');
    }
  });

  it('reads the slice under the pointer for a few known rotations', () => {
    const arc = (Math.PI * 2) / WHEEL_SEGMENTS;
    // Turned back half a slice: the middle of slice 0 is under the pointer.
    expect(segmentUnderPointer(-arc / 2)).toBe(0);
    // Turned forward half a slice: the last slice, which was at eleven o'clock, is under it.
    expect(segmentUnderPointer(arc / 2)).toBe(WHEEL_SEGMENTS - 1);
    // Forward a slice and a half: the one before that.
    expect(segmentUnderPointer(arc * 1.5)).toBe(WHEEL_SEGMENTS - 2);
    // A full turn changes nothing.
    expect(segmentUnderPointer(Math.PI * 2 + arc / 2)).toBe(WHEEL_SEGMENTS - 1);
  });

  it('always lands on the colour the coin flip chose', () => {
    for (const winner of ['BLUE', 'ORANGE'] as const) {
      for (let seed = 1; seed <= 500; seed++) {
        const angle = landingAngleFor(winner, seeded(seed));
        const slice = segmentUnderPointer(angle);
        expect(segmentTeam(slice), `${winner} seed ${seed} landed on slice ${slice}`).toBe(winner);
      }
    }
  });

  it('spins at least four full turns, so the spin is never a twitch', () => {
    for (let seed = 1; seed <= 50; seed++) {
      expect(landingAngleFor('BLUE', seeded(seed))).toBeGreaterThanOrEqual(4 * Math.PI * 2);
    }
  });

  it('never stops on a seam between two slices', () => {
    const arc = (Math.PI * 2) / WHEEL_SEGMENTS;
    const tau = Math.PI * 2;
    for (let seed = 1; seed <= 200; seed++) {
      const angle = landingAngleFor('ORANGE', seeded(seed));
      const local = ((-angle % tau) + tau) % tau;
      const intoSlice = (local % arc) / arc;
      expect(intoSlice).toBeGreaterThan(0.09);
      expect(intoSlice).toBeLessThan(0.91);
    }
  });
});

describe('generateWheelSpinGif', () => {
  const spin = generateWheelSpinGif(7, 'BLUE', seeded(42));

  it('is an animated GIF of the expected size and frame count', () => {
    expect(spin.buffer.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    // Logical screen size, little-endian, straight after the header.
    expect(spin.buffer.readUInt16LE(6)).toBe(SPIN_GIF_SIZE);
    expect(spin.buffer.readUInt16LE(8)).toBe(SPIN_GIF_SIZE);
    // One graphic control extension (21 F9 04) per frame.
    let frames = 0;
    for (let i = 0; i < spin.buffer.length - 2; i++) {
      if (spin.buffer[i] === 0x21 && spin.buffer[i + 1] === 0xf9 && spin.buffer[i + 2] === 0x04) frames++;
    }
    expect(frames).toBe(SPIN_FRAMES);
  });

  it('reports a duration the service can wait out, and the angle it landed on', () => {
    expect(spin.durationMs).toBeGreaterThan(3000);
    expect(spin.durationMs).toBeLessThan(6000);
    expect(segmentTeam(segmentUnderPointer(spin.landingAngle))).toBe('BLUE');
  });

  it('stays small enough to upload from the Pi without a wait', () => {
    expect(spin.buffer.length).toBeLessThan(1_000_000);
  });
});
