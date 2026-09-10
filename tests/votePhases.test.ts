import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import db from '../src/database/db';
import {
  ActiveQueue,
  createMatch,
  getMatch,
  getOrCreatePlayer,
  getQueue,
  saveQueue,
} from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import config from '../src/config';
import {
  startCaptainsVotePhase,
  startTeamsVotePhase,
  handleCaptainsVote,
  handleTeamsVote,
  sendCaptainsDraftCard,
  finalizeVoteAndPop,
} from '../src/services/votingService';
import {
  initializeCaptainsDraft,
  captainPairCount,
  matchupCount,
  randomizeCaptains,
} from '../src/services/draftService';
import { MAX_REROLLS } from '../src/services/gameRules';
import { SUPPORTED_TEAM_SIZES } from '../src/database/migrations';

const G = 'guild_vote_phases_test';
const CHAN = 'match_chan_vote_phases';
const ROSTER = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

/** Discord's live relative timestamp for a deadline, as the cards write it. */
const stamp = (atMs: number) => `<t:${Math.floor(atMs / 1000)}:R>`;

/** A message that records every edit made to it, so a test can see what the card became. */
function fakeMessage(id: string) {
  const edits: any[] = [];
  const msg: any = {
    id,
    edits,
    edit: async (payload: any) => {
      edits.push(payload);
      return msg;
    },
    delete: async () => null,
    reply: async () => null,
  };
  return msg;
}

/** A channel that records every send and hands back a recording message for each. */
function fakeChannel() {
  const sends: any[] = [];
  const messages: any[] = [];
  return {
    sends,
    messages,
    send: async (payload: any) => {
      sends.push(payload);
      const msg = fakeMessage(`msg_${sends.length}`);
      messages.push(msg);
      return msg;
    },
  };
}

/** Every channel lookup lands on the one fake channel; guild and user lookups miss. */
function clientWith(channel: ReturnType<typeof fakeChannel>) {
  return {
    channels: { fetch: async () => channel },
    guilds: { fetch: async () => null },
    users: { fetch: async () => null },
    user: { id: 'bot_1' },
  } as any;
}

function seedQueue(overrides: Partial<ActiveQueue> = {}): ActiveQueue {
  const queue: ActiveQueue = {
    channel_id: CHAN,
    guild_id: G,
    team_size: 3,
    player_ids: [...ROSTER],
    state: 'VOTING',
    vote_counts: { captains: [], balanced: [], random: [] },
    ...overrides,
  };
  saveQueue(queue);
  return queue;
}

/** The match row a real vote phase runs inside, keyed by its temporary text channel. */
function seedMatch() {
  return createMatch({
    guild_id: G,
    channel_id: 'queue_chan',
    team_size: 3,
    state: 'VOTING',
    blue_team: [...ROSTER],
    orange_team: [],
    text_channel_id: CHAN,
    queue_channel_id: 'queue_chan',
  });
}

describe('vote phase cards', () => {
  beforeEach(() => {
    db.exec(
      'DELETE FROM season_snapshots; DELETE FROM player_ladders; DELETE FROM players; ' +
        'DELETE FROM matches; DELETE FROM active_queues; DELETE FROM bans; DELETE FROM seasons; ' +
        'DELETE FROM guild_divisions; DELETE FROM guild_config;'
    );
    seedGuildDefaults(db, G);
    ROSTER.forEach((id, i) => {
      getOrCreatePlayer(G, 3, id, `User_${id}`);
      db.prepare('UPDATE player_ladders SET mmr = ? WHERE guild_id = ? AND team_size = 3 AND discord_id = ?').run(
        1000 + i * 50,
        G,
        id
      );
    });
    // Freeze the clock so the deadline on the card can be checked to the second, and so
    // no real 60-second timer is left running in the worker. setImmediate stays real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('visible deadlines', () => {
    it('captain vote says when it closes and that silence counts as Proceed', async () => {
      const channel = fakeChannel();
      const queue = seedQueue();

      await startCaptainsVotePhase(clientWith(channel), CHAN, G, queue, false);

      const closesAt = stamp(Date.now() + config.voteTimeoutSeconds * 1000);
      expect(channel.sends).toHaveLength(1);
      expect(channel.sends[0].content).toBe(`Closes ${closesAt} · no vote counts as Proceed · 3 re-rolls left`);
      expect(getQueue(CHAN)!.state).toBe('CAPTAINS_VOTE');
    });

    it('team vote says when it closes and that silence counts as Proceed', async () => {
      const channel = fakeChannel();
      const queue = seedQueue();

      await startTeamsVotePhase(clientWith(channel), CHAN, G, queue, 'balanced');

      const closesAt = stamp(Date.now() + config.voteTimeoutSeconds * 1000);
      expect(channel.sends[0].content).toBe(`Closes ${closesAt} · no vote counts as Proceed · 3 re-rolls left`);
      expect(getQueue(CHAN)!.state).toBe('TEAMS_VOTE');
    });

    it('a re-rolled card carries a fresh deadline', async () => {
      const channel = fakeChannel();
      const queue = seedQueue();
      await startTeamsVotePhase(clientWith(channel), CHAN, G, queue, 'random');
      const card = channel.messages[0];

      vi.advanceTimersByTime(20_000);
      await startTeamsVotePhase(clientWith(channel), CHAN, G, getQueue(CHAN)!, 'random', card);

      const closesAt = stamp(Date.now() + config.voteTimeoutSeconds * 1000);
      expect(card.edits[0].content).toContain(`Closes ${closesAt}`);
    });

    it('a tally update leaves the deadline line alone', async () => {
      const channel = fakeChannel();
      const client = clientWith(channel);
      await startCaptainsVotePhase(client, CHAN, G, seedQueue(), false);
      const captainCard = channel.messages[0];

      await handleCaptainsVote(client, CHAN, G, 'h3', 'yes', captainCard);

      // Discord keeps whatever fields an edit does not mention, so the line survives as
      // long as no edit names `content`.
      expect(captainCard.edits).toHaveLength(1);
      expect(captainCard.edits[0]).not.toHaveProperty('content');

      seedQueue();
      await startTeamsVotePhase(client, CHAN, G, getQueue(CHAN)!, 'random');
      const teamCard = channel.messages[1];

      await handleTeamsVote(client, CHAN, G, 'h3', 'no', teamCard);

      expect(teamCard.edits).toHaveLength(1);
      expect(teamCard.edits[0]).not.toHaveProperty('content');
    });

    it('draft card shows the auto-pick deadline', async () => {
      const channel = fakeChannel();
      const players = ROSTER.map(id => ({ discord_id: id, mmr: 1000 }) as any);
      const queue = seedQueue({ state: 'DRAFTING', draft_state: initializeCaptainsDraft(players) });

      await sendCaptainsDraftCard(clientWith(channel), CHAN, queue);

      const autoPickAt = stamp(Date.now() + config.draftPickTimeoutSeconds * 1000);
      expect(channel.sends[0].content).toBe(
        `🔵 <@${queue.draft_state!.blueCaptain}> — pick 1 of 3 · auto-pick ${autoPickAt}`
      );
    });

    it('the deadline on the card is the one the timer fires at', async () => {
      const channel = fakeChannel();
      seedMatch();
      await startTeamsVotePhase(clientWith(channel), CHAN, G, seedQueue(), 'random');
      const card = channel.messages[0];

      // One second short: nothing has happened yet.
      await vi.advanceTimersByTimeAsync(config.voteTimeoutSeconds * 1000 - 1000);
      expect(getQueue(CHAN)!.state).toBe('TEAMS_VOTE');
      expect(card.edits).toHaveLength(0);

      // Silence at the deadline is Proceed: the card collapses and the match starts.
      await vi.advanceTimersByTimeAsync(1000);
      expect(card.edits[0].content).toContain('Teams locked in');
      expect(getMatch(seedMatchId())!.state).toBe('IN_PROGRESS');
    });
  });

  describe('re-roll cap', () => {
    /** A No majority from the first four players, which resolves the vote as a re-roll. */
    async function rejectShowing(client: any, card: any, voteOn: typeof handleTeamsVote) {
      for (const id of ROSTER.slice(0, 4)) {
        await voteOn(client, CHAN, G, id, 'no', card);
      }
    }

    it('makes the split after MAX_REROLLS rejections final and locks it without a vote', async () => {
      const channel = fakeChannel();
      const client = clientWith(channel);
      seedMatch();
      await startTeamsVotePhase(client, CHAN, G, seedQueue(), 'random');
      const card = channel.messages[0];
      const keys = [getQueue(CHAN)!.team_vote_state!.seenMatchups!.at(-1)];

      for (let i = 1; i <= MAX_REROLLS; i++) {
        const before = card.edits.length;
        await rejectShowing(client, card, handleTeamsVote);
        keys.push(getQueue(CHAN)?.team_vote_state?.seenMatchups?.at(-1));

        // The showings before the cap are still votes, and count down what is left.
        if (i < MAX_REROLLS) {
          const reroll = card.edits.slice(before).find((e: any) => e.content?.startsWith('Closes'));
          expect(reroll.content).toContain(`${MAX_REROLLS - i} re-roll${MAX_REROLLS - i === 1 ? '' : 's'} left`);
          expect(reroll.components).toHaveLength(1);
          expect(getQueue(CHAN)!.state).toBe('TEAMS_VOTE');
        }
      }

      // The (MAX_REROLLS + 1)th showing says it is final, offers no buttons, and is locked
      // straight away -- no timer, no vote.
      const finalCard = card.edits.find((e: any) => e.content === '🔒 Final split — re-rolls used up');
      expect(finalCard.components).toEqual([]);
      expect(card.edits.at(-1).content).toBe('🔒 Teams locked in — re-rolls used up');
      expect(getMatch(seedMatchId())!.state).toBe('IN_PROGRESS');
      // Every showing was a different split, and the history holds all of them.
      expect(new Set(keys).size).toBe(MAX_REROLLS + 1);
    });

    it('makes the captain pair after MAX_REROLLS rejections final and opens the draft', async () => {
      const channel = fakeChannel();
      const client = clientWith(channel);
      await startCaptainsVotePhase(client, CHAN, G, seedQueue(), false);
      const card = channel.messages[0];

      // The first pair is part of the history, so the second re-roll cannot bring it back.
      expect(getQueue(CHAN)!.captain_vote_state!.seenCaptainPairs).toHaveLength(1);

      for (let i = 1; i <= MAX_REROLLS; i++) {
        await rejectShowing(client, card, handleCaptainsVote);
      }

      const finalCard = card.edits.find((e: any) => e.content === '🔒 Final pair — re-rolls used up');
      expect(finalCard.components).toEqual([]);
      expect(card.edits.at(-1).content).toMatch(/^🔒 Captains locked \(re-rolls used up\): 🔵 <@h\d> · 🟠 <@h\d>$/);
      expect(getQueue(CHAN)!.state).toBe('DRAFTING');
      // The draft card went out.
      expect(channel.sends.at(-1).content).toMatch(/pick 1 of 3/);
    });

    it('still reaches the final showing at 2v2, where the pool is smaller than the cap', async () => {
      // Three splits exist at 2v2, so the fourth showing has to repeat one. The history
      // must not be reset when the pool wraps (that would lose the re-roll count), and the
      // repeat must not be the split the lobby just rejected.
      const duo = ROSTER.slice(0, 4);
      duo.forEach(id => getOrCreatePlayer(G, 2, id, `User_${id}`));
      const channel = fakeChannel();
      const client = clientWith(channel);
      await startTeamsVotePhase(client, CHAN, G, seedQueue({ team_size: 2, player_ids: duo }), 'random');
      const card = channel.messages[0];

      const shown = [getQueue(CHAN)!.team_vote_state!.seenMatchups!.at(-1)];
      for (let i = 1; i <= MAX_REROLLS; i++) {
        for (const id of duo.slice(0, 3)) await handleTeamsVote(client, CHAN, G, id, 'no', card);
        const state = getQueue(CHAN)?.team_vote_state;
        if (state) shown.push(state.seenMatchups!.at(-1));
      }

      expect(matchupCount(2)).toBe(3);
      expect(new Set(shown.slice(0, 3)).size).toBe(3);
      expect(shown[3]).not.toBe(shown[2]);
      expect(card.edits.at(-1).content).toBe('🔒 Teams locked in — re-rolls used up');
    });

    it('rejects a click that lands on a final showing before it is locked', async () => {
      const client = clientWith(fakeChannel());
      const card = fakeMessage('late');
      seedQueue({
        state: 'TEAMS_VOTE',
        team_vote_state: {
          blueTeam: ROSTER.slice(0, 3),
          orangeTeam: ROSTER.slice(3),
          yesVotes: [],
          noVotes: [],
          seenMatchups: Array.from({ length: MAX_REROLLS + 1 }, (_, i) => `k${i}`),
          mode: 'random',
        },
      });

      const res = await handleTeamsVote(client, CHAN, G, 'h1', 'no', card);

      // No vote recorded, and no edit -- the tally edit would have put the buttons back.
      expect(res.success).toBe(false);
      expect(res.message).toMatch(/re-rolls used up/);
      expect(getQueue(CHAN)!.team_vote_state!.noVotes).toEqual([]);
      expect(card.edits).toHaveLength(0);
    });
  });
});

describe('finalizer lock', () => {
  beforeEach(() => {
    db.exec('DELETE FROM matches; DELETE FROM active_queues; DELETE FROM player_ladders; DELETE FROM players; DELETE FROM guild_divisions;');
    seedGuildDefaults(db, G);
    for (const id of ROSTER) getOrCreatePlayer(G, 3, id, id);
  });

  // The timer firing and a majority click landing in the same instant both used to pass
  // the state check, because the state only changes after the first one's message edit.
  it('resolves a mode vote once when two finalizers race', async () => {
    seedMatch();
    seedQueue({ vote_counts: { captains: [], balanced: ['h1', 'h2', 'h3', 'h4'], random: [] } });
    const channel = fakeChannel();
    const client = clientWith(channel);
    const voteCard = fakeMessage('mode_vote');

    await Promise.all([
      finalizeVoteAndPop(client, CHAN, G, voteCard),
      finalizeVoteAndPop(client, CHAN, G, voteCard),
    ]);

    // One collapse of the vote card, one Team Vote card sent, one state transition.
    expect(voteCard.edits.length).toBe(1);
    expect(channel.sends.length).toBe(1);
    expect(getQueue(CHAN)!.state).toBe('TEAMS_VOTE');
  });

  it('lets the next finalize through once the first has finished', async () => {
    seedMatch();
    seedQueue({ vote_counts: { captains: [], balanced: ['h1'], random: [] } });
    const channel = fakeChannel();
    const client = clientWith(channel);

    await finalizeVoteAndPop(client, CHAN, G, fakeMessage('a'));
    expect(getQueue(CHAN)!.state).toBe('TEAMS_VOTE');

    // A second call after the first completed is not blocked by the lock -- it is
    // stopped by the state check, which is the normal path.
    await finalizeVoteAndPop(client, CHAN, G, fakeMessage('b'));
    expect(channel.sends.length).toBe(1);
  });
});
describe('captainPairCount', () => {
  it.each([
    [2, 6],
    [3, 15],
    [4, 28],
  ])('%iv%i has %i distinct pairs', (teamSize, expected) => {
    expect(captainPairCount(teamSize)).toBe(expected);
  });

  it('agrees with the pool randomizeCaptains actually draws from', () => {
    for (const teamSize of SUPPORTED_TEAM_SIZES) {
      const players = Array.from({ length: teamSize * 2 }, (_, i) => ({
        discord_id: `p${i}`,
        mmr: 1000,
      })) as any[];

      // Draw with a growing seen-list: every draw is new until the pool is exhausted,
      // and the very next one is a repeat.
      const seen: string[] = [];
      for (let i = 0; i < captainPairCount(teamSize); i++) {
        const { pairKey } = randomizeCaptains(players, undefined, undefined, seen);
        expect(seen).not.toContain(pairKey);
        seen.push(pairKey);
      }
      expect(seen).toContain(randomizeCaptains(players, undefined, undefined, seen).pairKey);
    }
  });
});

/** The single match row seeded for this channel. */
function seedMatchId(): number {
  return (db.prepare('SELECT match_id FROM matches WHERE text_channel_id = ?').get(CHAN) as any).match_id;
}
