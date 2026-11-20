import net from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS, relaxHappyEyeballs } from '../src/utils/network';

/**
 * The happy-eyeballs connect limit. Node's 250 ms default is shorter than the Pi's round
 * trip to hc-ping.com, which made every heartbeat fail with ETIMEDOUT.
 */
describe('relaxHappyEyeballs', () => {
  const original = net.getDefaultAutoSelectFamilyAttemptTimeout();
  afterEach(() => net.setDefaultAutoSelectFamilyAttemptTimeout(original));

  it('raises the per-address connect timeout well above a far-away round trip', () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(250);
    relaxHappyEyeballs();
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS);
    // About 305 ms from the Pi to hc-ping.com; leave plenty of room for a bad day.
    expect(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
  });

  it('leaves a higher value alone', () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(5_000);
    relaxHappyEyeballs();
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(5_000);
  });
});
