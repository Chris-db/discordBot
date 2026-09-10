import { describe, it, expect, beforeEach, vi } from 'vitest';
import db from '../src/database/db';
import { saveQueue, getQueue, updateDivision, ActiveQueue } from '../src/database/queries';
import { seedGuildDefaults } from '../src/database/migrations';
import { sweepStrayQueuePanels } from '../src/services/queueTimeout';
import { handleChannelMessage } from '../src/services/queuePanel';

const G = 'guild_stray_test';
const QUEUE_CHAN = 'stray_queue_chan';
const GENERAL = 'stray_general_chan';

function row(channelId: string, overrides: Partial<ActiveQueue> = {}): ActiveQueue {
  const queue: ActiveQueue = {
    channel_id: channelId,
    guild_id: G,
    team_size: 3,
    message_id: `panel_${channelId}`,
    player_ids: [],
    player_join_times: {},
    state: 'WAITING',
    vote_counts: {},
    ...overrides,
  };
  saveQueue(queue);
  return queue;
}

/** A client whose channels all exist and record which messages were deleted. */
function clientRecordingDeletes() {
  const deleted: string[] = [];
  return {
    client: {
      channels: {
        fetch: async (id: string) => ({
          id,
          messages: { delete: async (mid: string) => { deleted.push(`${id}:${mid}`); } },
        }),
      },
    } as any,
    deleted,
  };
}

describe('stray queue panels', () => {
  beforeEach(() => {
    db.exec(`DELETE FROM active_queues WHERE guild_id = '${G}'; DELETE FROM guild_divisions WHERE guild_id = '${G}';`);
    seedGuildDefaults(db, G);
  });

  describe('boot sweep', () => {
    it('removes the panel and row from a channel that is not registered', async () => {
      updateDivision(G, 3, 'C', { queue_channel_id: QUEUE_CHAN });
      row(QUEUE_CHAN);
      row(GENERAL);

      const { client, deleted } = clientRecordingDeletes();
      const cleaned = await sweepStrayQueuePanels(client);

      expect(cleaned).toEqual([GENERAL]);
      expect(deleted).toEqual([`${GENERAL}:panel_${GENERAL}`]);
      expect(getQueue(GENERAL)).toBeUndefined();
      expect(getQueue(QUEUE_CHAN)).toBeDefined();
    });

    it('leaves a guild alone that has not registered any channel yet', async () => {
      row(QUEUE_CHAN);

      const { client, deleted } = clientRecordingDeletes();
      expect(await sweepStrayQueuePanels(client)).toEqual([]);
      expect(deleted).toEqual([]);
      expect(getQueue(QUEUE_CHAN)).toBeDefined();
    });

    it('never touches a row with players in it or one that is mid-pop', async () => {
      updateDivision(G, 3, 'C', { queue_channel_id: QUEUE_CHAN });
      row('stray_busy', { player_ids: ['p1'] });
      row('stray_popping', { state: 'READY_CHECK' });

      const { client } = clientRecordingDeletes();
      expect(await sweepStrayQueuePanels(client)).toEqual([]);
      expect(getQueue('stray_busy')).toBeDefined();
      expect(getQueue('stray_popping')).toBeDefined();
    });
  });

  describe('chat re-pin', () => {
    it('only re-pins the panel in a registered queue channel', async () => {
      vi.useFakeTimers();
      try {
        updateDivision(G, 3, 'C', { queue_channel_id: QUEUE_CHAN });
        row(QUEUE_CHAN);
        row(GENERAL);

        const fetched: string[] = [];
        const client = {
          channels: { fetch: async (id: string) => { fetched.push(id); return null; } },
        } as any;
        const message = (channelId: string) => ({ author: { bot: false }, channelId }) as any;

        handleChannelMessage(client, message(GENERAL));
        handleChannelMessage(client, message(QUEUE_CHAN));
        await vi.runAllTimersAsync();

        expect(fetched).toEqual([QUEUE_CHAN]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
