import { describe, it, expect, vi, afterEach } from 'vitest';
import { autoDeleteReply } from '../src/utils/autoDelete';

/**
 * autoDeleteReply must time from the moment a reply is *sent*, not deferred. Chris's 2v2
 * run on a slow evening: one click finalised a vote and set up the next phase inline,
 * which took longer than the 6s delay; the timer (started on deferral) deleted the
 * ephemeral reply first, and editReply then hit 10008 Unknown Message.
 */

function fakeInteraction() {
  const state = { deferred: false, replied: false, deleted: 0 };
  const interaction = {
    isRepliable: () => true,
    get deferred() {
      return state.deferred;
    },
    get replied() {
      return state.replied;
    },
    deleteReply: async () => {
      state.deleted++;
    },
  } as any;
  return { interaction, state };
}

describe('autoDeleteReply', () => {
  afterEach(() => vi.useRealTimers());

  it('does not start the countdown on deferral', () => {
    vi.useFakeTimers();
    const { interaction, state } = fakeInteraction();
    autoDeleteReply(interaction, 6000);

    state.deferred = true;
    vi.advanceTimersByTime(20_000); // a slow handler, well past the delay
    expect(state.deleted).toBe(0);
  });

  it('deletes the reply delayMs after it is actually sent', () => {
    vi.useFakeTimers();
    const { interaction, state } = fakeInteraction();
    autoDeleteReply(interaction, 6000);

    state.deferred = true;
    vi.advanceTimersByTime(10_000);
    state.replied = true; // editReply happened here
    vi.advanceTimersByTime(5_000);
    expect(state.deleted).toBe(0);
    vi.advanceTimersByTime(1_400);
    expect(state.deleted).toBe(1);
  });

  it('gives up quietly if nothing is ever sent', () => {
    vi.useFakeTimers();
    const { interaction, state } = fakeInteraction();
    autoDeleteReply(interaction, 6000);
    vi.advanceTimersByTime(120_000);
    expect(state.deleted).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
