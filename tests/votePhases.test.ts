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
} from '../src/services/votingService';
import { initializeCaptainsDraft } from '../src/services/draftService';

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
      expect(channel.sends[0].content).toBe(`Closes ${closesAt} · no vote counts as Proceed`);
      expect(getQueue(CHAN)!.state).toBe('CAPTAINS_VOTE');
    });

    it('team vote says when it closes and that silence counts as Proceed', async () => {
      const channel = fakeChannel();
      const queue = seedQueue();

      await startTeamsVotePhase(clientWith(channel), CHAN, G, queue, 'balanced');

      const closesAt = stamp(Date.now() + config.voteTimeoutSeconds * 1000);
      expect(channel.sends[0].content).toBe(`Closes ${closesAt} · no vote counts as Proceed`);
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
});

/** The single match row seeded for this channel. */
function seedMatchId(): number {
  return (db.prepare('SELECT match_id FROM matches WHERE text_channel_id = ?').get(CHAN) as any).match_id;
}
