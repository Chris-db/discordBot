import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import { createMatch, getMatch, getOrCreatePlayer } from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import { handleMatchReportVote, isReportSplit } from '../src/services/matchService';

const G = 'guild_split_report_test';
const BLUE = ['b1', 'b2', 'b3'];
const ORANGE = ['o1', 'o2', 'o3'];

/** Records every send to the match channel; the guild lookup misses, so no feed post. */
function recordingClient() {
  const sends: string[] = [];
  return {
    sends,
    client: {
      channels: { fetch: async () => ({ send: async (p: any) => { sends.push(p.content); }, messages: { fetch: async () => null } }) },
      guilds: { fetch: async () => null },
      users: { fetch: async () => null },
      user: { id: 'bot_1' },
    } as any,
  };
}

function liveMatch() {
  return createMatch({
    guild_id: G,
    channel_id: 'queue_chan',
    team_size: 3,
    state: 'IN_PROGRESS',
    blue_team: BLUE,
    orange_team: ORANGE,
    rl_name: 'RL42',
    rl_pass: '317',
    text_channel_id: 'match_chan',
  });
}

describe('split reports', () => {
  beforeEach(() => {
    db.exec('DELETE FROM matches; DELETE FROM player_ladders; DELETE FROM players; DELETE FROM guild_divisions;');
    seedGuildDefaults(db, G);
    for (const id of [...BLUE, ...ORANGE]) getOrCreatePlayer(G, 3, id, id);
  });

  describe('isReportSplit', () => {
    const withVotes = (blue: string[], orange: string[], cancel: string[] = []) => ({
      ...liveMatch(),
      report_status: { blueVotes: blue, orangeVotes: orange, cancelVotes: cancel },
    });

    it('is split once neither side can reach the majority with the votes left', () => {
      expect(isReportSplit(withVotes(['b1', 'b2', 'b3'], ['o1', 'o2', 'o3']), 4)).toBe(true);
    });

    it('is not split while the unvoted could still tip either side', () => {
      // Two Blue, one Orange, three still to vote: Blue reaches 4 if two of them agree.
      expect(isReportSplit(withVotes(['b1', 'b2'], ['o1']), 4)).toBe(false);
    });

    it('is not split when only one side has reported', () => {
      expect(isReportSplit(withVotes(['b1', 'b2', 'b3'], []), 4)).toBe(false);
    });

    it('counts cancel votes as cast, not as available to either side', () => {
      // 3 Blue, 2 Orange, 1 cancel: nobody is left to get Blue to 4.
      expect(isReportSplit(withVotes(['b1', 'b2', 'b3'], ['o1', 'o2'], ['o3']), 4)).toBe(true);
    });
  });

  describe('the notice', () => {
    it('goes out once when the sixth vote makes it 3/3, and not again on a re-vote', async () => {
      const match = liveMatch();
      const { client, sends } = recordingClient();

      for (const id of BLUE) await handleMatchReportVote(client, match.match_id, id, 'BLUE');
      for (const id of ['o1', 'o2']) await handleMatchReportVote(client, match.match_id, id, 'ORANGE');
      expect(sends.filter(s => s.includes('Reports disagree'))).toHaveLength(0);

      await handleMatchReportVote(client, match.match_id, 'o3', 'ORANGE');
      expect(sends.filter(s => s.includes('Reports disagree'))).toHaveLength(1);
      expect(getMatch(match.match_id)!.report_status.disputeNoticed).toBe(true);

      // o3 flips to Blue and back: still split, still one notice.
      await handleMatchReportVote(client, match.match_id, 'o3', 'BLUE');
      expect(getMatch(match.match_id)!.state).toBe('COMPLETED'); // 4 Blue settles it
    });

    it('does not fire on a report that is still winnable', async () => {
      const match = liveMatch();
      const { client, sends } = recordingClient();

      await handleMatchReportVote(client, match.match_id, 'b1', 'BLUE');
      await handleMatchReportVote(client, match.match_id, 'o1', 'ORANGE');

      expect(sends.filter(s => s.includes('Reports disagree'))).toHaveLength(0);
      expect(getMatch(match.match_id)!.report_status.disputeNoticed).toBeUndefined();
    });
  });
});
