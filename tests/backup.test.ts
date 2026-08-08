import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import db from '../src/database/db';
import { getOrCreatePlayer, updatePlayerAfterMatch } from '../src/database/queries';
import { runBackup, pruneBackups, getBackupDir, backupTick } from '../src/services/backupService';
import config from '../src/config';

// Keep each worker's backups separate, same as the databases themselves.
config.backupDir = path.join('data', `test_backups_${process.env.VITEST_WORKER_ID ?? '0'}`);

const dir = getBackupDir();
const clean = () => fs.rmSync(dir, { recursive: true, force: true });
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const stamp = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('nightly database backup', () => {
  beforeEach(() => {
    clean();
    db.exec('DELETE FROM player_ladders; DELETE FROM players;');
  });

  afterAll(clean);

  it('writes a backup that is a real, readable database with the data in it', () => {
    getOrCreatePlayer('g1', 3, 'p1', 'Chris');
    updatePlayerAfterMatch('g1', 3, 'p1', 250, true);

    const file = runBackup();
    expect(file).toBeTruthy();
    expect(fs.existsSync(file!)).toBe(true);

    // Open the snapshot independently — a file existing proves nothing about its contents.
    const snapshot = new Database(file!, { readonly: true });
    try {
      const row = snapshot
        .prepare(
          `SELECT p.username, l.mmr, l.wins FROM player_ladders l
           JOIN players p ON p.guild_id = l.guild_id AND p.discord_id = l.discord_id
           WHERE l.discord_id = ? AND l.team_size = 3`
        )
        .get('p1') as any;
      expect(row.username).toBe('Chris');
      expect(row.mmr).toBe(1250);
      expect(row.wins).toBe(1);
    } finally {
      snapshot.close();
    }
  });

  it('is a no-op if today has already been backed up', () => {
    expect(runBackup()).toBeTruthy();
    expect(runBackup()).toBeNull();
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.sqlite'))).toHaveLength(1);
  });

  it('recovers from a leftover .partial file rather than blocking forever', () => {
    // VACUUM INTO refuses to write to an existing path, so a crash mid-backup could
    // otherwise wedge every future attempt.
    fs.mkdirSync(dir, { recursive: true });
    const partial = path.join(dir, `6mans-${stamp(new Date())}.sqlite.partial`);
    fs.writeFileSync(partial, 'garbage from a crashed run');

    expect(runBackup()).toBeTruthy();
    expect(fs.existsSync(partial)).toBe(false);
  });

  it('deletes backups past the retention window and keeps the rest', () => {
    fs.mkdirSync(dir, { recursive: true });
    const keep = [0, 1, config.backupRetentionDays - 1];
    const drop = [config.backupRetentionDays + 1, config.backupRetentionDays + 40];

    for (const d of [...keep, ...drop]) {
      fs.writeFileSync(path.join(dir, `6mans-${stamp(daysAgo(d))}.sqlite`), 'x');
    }

    expect(pruneBackups()).toBe(drop.length);

    const left = fs.readdirSync(dir).sort();
    expect(left).toHaveLength(keep.length);
    for (const d of keep) {
      expect(left).toContain(`6mans-${stamp(daysAgo(d))}.sqlite`);
    }
  });

  it('never deletes files it did not create', () => {
    fs.mkdirSync(dir, { recursive: true });
    const bystanders = ['important-notes.txt', 'manual-backup.sqlite', '6mans-not-a-date.sqlite'];
    for (const name of bystanders) fs.writeFileSync(path.join(dir, name), 'x');
    // An ancient file that DOES match the pattern, to prove pruning still works around them.
    fs.writeFileSync(path.join(dir, `6mans-${stamp(daysAgo(999))}.sqlite`), 'x');

    expect(pruneBackups()).toBe(1);
    for (const name of bystanders) {
      expect(fs.existsSync(path.join(dir, name))).toBe(true);
    }
  });

  it('does not throw when backups are disabled', () => {
    const original = config.backupEnabled;
    config.backupEnabled = false;
    try {
      expect(() => backupTick()).not.toThrow();
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      config.backupEnabled = original;
    }
  });
});
