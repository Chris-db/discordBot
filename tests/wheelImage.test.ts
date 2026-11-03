import { describe, it, expect } from 'vitest';
import {
  landingAngleFor,
  segmentUnderPointer,
  segmentTeam,
  generateWheelSpinGif,
  spinFrameCount,
  spinProfile,
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

  it('spins at least three full turns, so the spin is never a twitch', () => {
    for (let seed = 1; seed <= 50; seed++) {
      expect(landingAngleFor('BLUE', seeded(seed))).toBeGreaterThanOrEqual(3 * Math.PI * 2);
    }
  });

  it('never turns more than half a slice between frames, so the slices cannot strobe', () => {
    // Eight identical slices stepping half a slice or more per frame read as a slower or
    // backwards wheel. The frame count is sized from the angle to keep under that.
    const halfSlice = Math.PI / WHEEL_SEGMENTS;
    for (let seed = 1; seed <= 50; seed++) {
      const angle = landingAngleFor('BLUE', seeded(seed));
      const frames = spinFrameCount(angle);
      let largest = 0;
      for (let f = 1; f < frames; f++) {
        const step = angle * (spinProfile(f / (frames - 1)) - spinProfile((f - 1) / (frames - 1)));
        expect(step).toBeGreaterThanOrEqual(0);
        largest = Math.max(largest, step);
      }
      expect(largest).toBeLessThan(halfSlice);
      expect(spinProfile(1)).toBeCloseTo(1, 9);
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
    // One graphic control extension (21 F9 04) per frame: the spin's full frames, then
    // the hold's 1×1 transparent ones (image descriptor 2C, x 0, y 0, w 1, h 1).
    let frames = 0;
    let holdFrames = 0;
    for (let i = 0; i < spin.buffer.length - 9; i++) {
      if (spin.buffer[i] === 0x21 && spin.buffer[i + 1] === 0xf9 && spin.buffer[i + 2] === 0x04) frames++;
      if (
        spin.buffer[i] === 0x2c &&
        spin.buffer.readUInt16LE(i + 1) === 0 &&
        spin.buffer.readUInt16LE(i + 3) === 0 &&
        spin.buffer.readUInt16LE(i + 5) === 1 &&
        spin.buffer.readUInt16LE(i + 7) === 1
      ) holdFrames++;
    }
    expect(holdFrames).toBeGreaterThan(30);
    // The cover, then the spin, then the hold.
    expect(frames).toBe(1 + spinFrameCount(spin.landingAngle) + holdFrames);
  });

  it('opens on a cover frame that is gone in 20 ms', () => {
    // With GIF autoplay off, Discord shows the first frame still until it is tapped, so
    // the first frame carries the "Tap to spin" label. It must be full-size, or the
    // still would be a sliver, and short enough that an autoplaying viewer never sees it.
    const gce = spin.buffer.indexOf(Buffer.from([0x21, 0xf9, 0x04]));
    // Delay is in hundredths of a second, little-endian, after the packed byte.
    expect(spin.buffer.readUInt16LE(gce + 4)).toBe(2);
    const descriptor = spin.buffer.indexOf(0x2c, gce + 8);
    expect(spin.buffer.readUInt16LE(descriptor + 5)).toBe(SPIN_GIF_SIZE);
    expect(spin.buffer.readUInt16LE(descriptor + 7)).toBe(SPIN_GIF_SIZE);
    // The next frame is the spin at full speed, not another 20 ms one.
    const next = spin.buffer.indexOf(Buffer.from([0x21, 0xf9, 0x04]), descriptor);
    expect(spin.buffer.readUInt16LE(next + 4)).toBeGreaterThan(2);
  });

  it('is written to play once, not loop', () => {
    // The NETSCAPE2.0 application extension is what asks a player to loop.
    expect(spin.buffer.indexOf(Buffer.from('NETSCAPE2.0', 'ascii'))).toBe(-1);
  });

  it('reports when the wheel lands, the whole play time, and the angle it landed on', () => {
    expect(spin.landedAfterMs).toBeGreaterThan(1500);
    expect(spin.landedAfterMs).toBeLessThan(7000);
    // The landed hold is long enough that a looping player cannot restart the spin
    // before the service, which waits landedAfterMs + 3 s, has collapsed the message.
    expect(spin.durationMs - spin.landedAfterMs).toBeGreaterThanOrEqual(10_000);
    expect(segmentTeam(segmentUnderPointer(spin.landingAngle))).toBe('BLUE');
  });

  it('stays small enough to upload from the Pi without a wait', () => {
    expect(spin.buffer.length).toBeLessThan(1_600_000);
  });
});
