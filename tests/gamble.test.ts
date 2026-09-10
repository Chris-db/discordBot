import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import db from '../src/database/db';
import {
  createMatch,
  getMatch,
  updateMatch,
  getOrCreatePlayer,
  mutateMatchReportStatus,
} from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import {
  proposeGamble,
  handleGambleAgree,
  handleGambleDecline,
  voidPendingGamble,
} from '../src/services/gambleService';
import { startRematch, handleRequeue, handleRematchVote } from '../src/services/rematchService';
import {
  scheduleMatchChannelDeletion,
  cancelMatchChannelDeletion,
  hasPendingChannelDeletion,
} from '../src/services/channelService';
import { REMATCH_WINDOW_MS } from '../src/services/gameRules';

const G = 'guild_gamble_test';
const BLUE = ['b1', 'b2', 'b3'];
const ORANGE = ['o1', 'o2', 'o3'];
const ROSTER = [...BLUE, ...ORANGE];

/** Every channel lookup misses, so nothing is sent; the DB and the timers are what we assert. */
const fakeClient = {
  channels: { fetch: async () => null },
  guilds: { fetch: async () => null },
  users: { fetch: async () => null },
  user: { id: 'bot_1' },
} as any;

/** A button click, reduced to what the gamble handlers read off it. */
function click(userId: string) {
  const replies: any[] = [];
  const updates: any[] = [];
  return {
    user: { id: userId },
    channelId: 'match_chan',
    message: { id: 'gamble_msg' },
    reply: async (payload: any) => {
      replies.push(payload);
      return { id: 'gamble_msg' };
    },
    update: async (payload: any) => {
      updates.push(payload);
    },
    replies,
    updates,
  } as any;
}

/** A finished match sitting in its rematch window, teardown scheduled exactly as completeMatch does. */
function makeCompletedMatch() {
  const match = createMatch({
    guild_id: G,
    channel_id: 'queue_chan',
    blue_team: BLUE,
    orange_team: ORANGE,
    rl_name: 'RL42',
    rl_pass: '317',
    text_channel_id: 'match_chan',
    queue_channel_id: 'queue_chan',
  });
  updateMatch(match.match_id, { state: 'COMPLETED', winner: 'BLUE', completed_at: new Date().toISOString() });
  scheduleMatchChannelDeletion(fakeClient, match.match_id, REMATCH_WINDOW_MS);
  return getMatch(match.match_id)!;
}

describe('double or nothing', () => {
  let matchId: number;

  beforeEach(() => {
    // The gamble window and the teardown are both real timers. Faking them keeps a 60s
    // timeout from outliving the test, and lets the expiry be driven rather than waited for.
    vi.useFakeTimers();
    db.exec('DELETE FROM season_snapshots; DELETE FROM player_ladders; DELETE FROM players; DELETE FROM matches; DELETE FROM active_queues; DELETE FROM bans; DELETE FROM seasons; DELETE FROM guild_divisions; DELETE FROM guild_config;');
    seedGuildDefaults(db, G);
    for (const id of ROSTER) getOrCreatePlayer(G, 3, id, `User_${id}`);
    matchId = makeCompletedMatch().match_id;
  });

  afterEach(async () => {
    await voidPendingGamble(fakeClient, matchId);
    cancelMatchChannelDeletion(matchId);
    vi.useRealTimers();
  });

  const gambleState = () => getMatch(matchId)!.gamble_status!.state;

  describe('the channel teardown', () => {
    // The reported bug: the window is 60s and the teardown 90s, so a proposal made 40s in
    // had its wheel spin in a channel that no longer existed.
    it('is cancelled while a proposal is open', async () => {
      expect(hasPendingChannelDeletion(matchId)).toBe(true);

      const c = click('b1');
      await proposeGamble(fakeClient, c, matchId);

      expect(gambleState()).toBe('PROPOSED');
      expect(c.replies[0].embeds).toHaveLength(1);
      expect(hasPendingChannelDeletion(matchId)).toBe(false);
    });

    it('comes back once the proposal expires', async () => {
      await proposeGamble(fakeClient, click('b1'), matchId);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(gambleState()).toBe('EXPIRED');
      expect(hasPendingChannelDeletion(matchId)).toBe(true);

      // ...and the replacement is a real timer that fires, not just a map entry.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(hasPendingChannelDeletion(matchId)).toBe(false);
    });

    it('comes back once the proposal is declined', async () => {
      await proposeGamble(fakeClient, click('b1'), matchId);

      const c = click('o1');
      await handleGambleDecline(fakeClient, c, matchId);

      expect(gambleState()).toBe('DECLINED');
      expect(getMatch(matchId)!.gamble_status!.declinedBy).toBe('o1');
      expect(c.updates[0].components).toEqual([]);
      expect(hasPendingChannelDeletion(matchId)).toBe(true);
      // The gamble timer is gone too; only the teardown remains.
      expect(vi.getTimerCount()).toBe(1);
    });

    it('is left alone when a rematch has taken the channel over', async () => {
      await proposeGamble(fakeClient, click('b1'), matchId);

      const next = (await startRematch(fakeClient, matchId))!;
      expect(next.text_channel_id).toBe('match_chan');

      expect(gambleState()).toBe('EXPIRED');
      // No teardown for the old match: it would delete the channel the rematch is in.
      expect(hasPendingChannelDeletion(matchId)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('once the lobby has broken up', () => {
    it('a live rematch voids an open proposal', async () => {
      await proposeGamble(fakeClient, click('b1'), matchId);
      await startRematch(fakeClient, matchId);

      expect(gambleState()).toBe('EXPIRED');
    });

    it('the first requeue voids an open proposal and puts the teardown back', async () => {
      await proposeGamble(fakeClient, click('b1'), matchId);
      expect(hasPendingChannelDeletion(matchId)).toBe(false);

      await handleRequeue(fakeClient, matchId, 'b1');

      expect(gambleState()).toBe('EXPIRED');
      expect(hasPendingChannelDeletion(matchId)).toBe(true);
    });

    it('refuses a proposal after a requeue', async () => {
      await handleRequeue(fakeClient, matchId, 'b1');

      const c = click('b2');
      await proposeGamble(fakeClient, c, matchId);

      expect(c.replies[0].content).toMatch(/moved on/);
      expect(c.replies[0].ephemeral).toBe(true);
      expect(gambleState()).toBe('NONE');
      // A refused proposal must not touch the teardown that is already running.
      expect(hasPendingChannelDeletion(matchId)).toBe(true);
    });

    it('refuses a proposal on the previous game once a rematch is live', async () => {
      await startRematch(fakeClient, matchId);

      const c = click('b2');
      await proposeGamble(fakeClient, c, matchId);

      expect(c.replies[0].content).toMatch(/moved on/);
      expect(gambleState()).toBe('NONE');
    });

    // A declined rematch vote sets rematchResolved too, but the teams are still there and
    // the card leaves the Double or Nothing button live. Voiding on the flag alone would
    // have killed the gamble in exactly the case players reach for it.
    it('still allows a proposal after the rematch vote failed', async () => {
      for (const id of ['b1', 'b2', 'b3']) {
        await handleRematchVote(fakeClient, matchId, id, 'no');
      }
      expect(getMatch(matchId)!.report_status.rematchResolved).toBe(true);

      await proposeGamble(fakeClient, click('o1'), matchId);

      expect(gambleState()).toBe('PROPOSED');
    });

    // The rematch and requeue paths collapse the card themselves, but a click can already
    // be in flight when they do.
    it('an agree that lands late collapses the card instead of counting', async () => {
      await proposeGamble(fakeClient, click('b1'), matchId);
      mutateMatchReportStatus(matchId, status => {
        status.rematchResolved = true;
        status.requeued = ['b2'];
      });

      const c = click('o1');
      await handleGambleAgree(fakeClient, c, matchId);

      expect(c.updates[0].content).toMatch(/moved on/);
      expect(c.updates[0].components).toEqual([]);
      expect(gambleState()).toBe('EXPIRED');
      expect(getMatch(matchId)!.gamble_status!.agreedPlayers).toEqual(['b1']);
      expect(hasPendingChannelDeletion(matchId)).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('voiding with nothing open is a no-op', async () => {
      cancelMatchChannelDeletion(matchId);

      expect(await voidPendingGamble(fakeClient, matchId)).toBe(false);

      expect(gambleState()).toBe('NONE');
      expect(hasPendingChannelDeletion(matchId)).toBe(false);
    });
  });

  describe('the countdown', () => {
    const deadlineOf = (payload: any): string | undefined =>
      payload.embeds[0].data.description.match(/<t:\d+:R>/)?.[0];

    // A `<t:…:R>` ticks on every viewer's screen by itself. The card used to carry a
    // seconds-remaining figure that only moved when someone clicked.
    it('is a Discord timestamp fixed at proposal time, not re-derived per click', async () => {
      const proposedAt = Date.now();
      const first = click('b1');
      await proposeGamble(fakeClient, first, matchId);

      const expected = `<t:${Math.floor((proposedAt + 60_000) / 1000)}:R>`;
      expect(deadlineOf(first.replies[0])).toBe(expected);

      await vi.advanceTimersByTimeAsync(20_000);
      const later = click('o1');
      await handleGambleAgree(fakeClient, later, matchId);

      expect(deadlineOf(later.updates[0])).toBe(expected);
    });

    it('expires at the instant the card advertises', async () => {
      await proposeGamble(fakeClient, click('b1'), matchId);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(gambleState()).toBe('PROPOSED');

      await vi.advanceTimersByTimeAsync(1);
      expect(gambleState()).toBe('EXPIRED');
    });
  });

  describe('agreeing', () => {
    it('records each player once and keeps the timer running', async () => {
      await proposeGamble(fakeClient, click('b1'), matchId);

      await handleGambleAgree(fakeClient, click('o1'), matchId);
      const again = click('o1');
      await handleGambleAgree(fakeClient, again, matchId);

      expect(getMatch(matchId)!.gamble_status!.agreedPlayers).toEqual(['b1', 'o1']);
      expect(again.replies[0].content).toMatch(/already agreed/);
      expect(gambleState()).toBe('PROPOSED');
      expect(hasPendingChannelDeletion(matchId)).toBe(false);
    });
  });
});
