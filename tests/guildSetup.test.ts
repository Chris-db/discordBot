import { describe, it, expect, beforeEach } from 'vitest';
import db from '../src/database/db';
import { ensureGuildDefaults } from '../src/services/guildSetup';
import { getLowestDivision, getDivisionByChannel, updateDivision, getActiveSeason } from '../src/database/queries';

const G = 'guild_setup_test';

describe('ensureGuildDefaults', () => {
  beforeEach(() => {
    db.exec(
      `DELETE FROM guild_divisions WHERE guild_id = '${G}'; DELETE FROM guild_config WHERE guild_id = '${G}';
       DELETE FROM season_snapshots WHERE season_id IN (SELECT season_id FROM seasons WHERE guild_id = '${G}');
       DELETE FROM seasons WHERE guild_id = '${G}';`
    );
  });

  it('a guild that joined after migration 2 gets its divisions, config and Season 1', () => {
    expect(getLowestDivision(G, 3)).toBeUndefined();

    expect(ensureGuildDefaults(G)).toBe(true);

    const rows = db.prepare('SELECT COUNT(*) AS n FROM guild_divisions WHERE guild_id = ?').get(G) as { n: number };
    expect(rows.n).toBe(15);
    expect(getLowestDivision(G, 3)?.division).toBe('C');
    expect(getActiveSeason(G)?.name).toBe('Season 1');
  });

  it('is a no-op the second time and never touches a registration', () => {
    ensureGuildDefaults(G);
    updateDivision(G, 3, 'B', { queue_channel_id: 'setup_chan_b' });

    expect(ensureGuildDefaults(G)).toBe(false);
    expect(getDivisionByChannel(G, 'setup_chan_b')?.division).toBe('B');
    expect(getActiveSeason(G)?.name).toBe('Season 1');
  });

  it('registering a channel in an unseeded guild used to update nothing; now it sticks', () => {
    // The bug as seen on the first test server: UPDATE on rows that did not exist.
    updateDivision(G, 3, 'C', { queue_channel_id: 'setup_chan_c' });
    expect(getDivisionByChannel(G, 'setup_chan_c')).toBeUndefined();

    ensureGuildDefaults(G);
    updateDivision(G, 3, 'C', { queue_channel_id: 'setup_chan_c' });
    expect(getDivisionByChannel(G, 'setup_chan_c')?.division).toBe('C');
  });
});
