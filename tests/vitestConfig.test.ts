import { describe, it, expect } from 'vitest';
import viteConfig from '../vitest.config.mts';

/**
 * Regression for issue #2: raising testTimeout alone (a64b7a3) did not help the migration
 * tests' slow beforeEach hooks, which vitest times separately and still capped at its 10 s
 * default -- that hook timeout is what actually tripped the Pi's deploy gate.
 */
describe('vitest deploy-gate timeouts', () => {
  it('gives hooks at least as long as test bodies on the Pi', () => {
    const testTimeout = viteConfig.test?.testTimeout ?? 5_000;
    const hookTimeout = viteConfig.test?.hookTimeout ?? 10_000;
    expect(hookTimeout).toBeGreaterThanOrEqual(testTimeout);
  });
});
