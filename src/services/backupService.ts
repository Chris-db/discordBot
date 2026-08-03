import fs from 'fs';
import path from 'path';
import db from '../database/db';
import config from '../config';
import { logger } from '../utils/logger';

const BACKUP_PREFIX = '6mans-';
const BACKUP_SUFFIX = '.sqlite';
/** Matches the files this module creates, so we never delete anything we didn't write. */
const BACKUP_PATTERN = /^6mans-(\d{4}-\d{2}-\d{2})\.sqlite$/;

/** Local (not UTC) date, so a backup is named for the day it felt like to the server owner. */
function localDateStamp(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getBackupDir(): string {
  return path.isAbsolute(config.backupDir)
    ? config.backupDir
    : path.join(process.cwd(), config.backupDir);
}

/**
 * Writes today's backup if it doesn't exist yet.
 *
 * Uses SQLite's VACUUM INTO rather than a file copy: it takes a read lock and produces a
 * consistent, already-compacted database even while the bot is mid-write. Copying the file
 * by hand can catch it between a WAL write and a checkpoint and yield a corrupt snapshot.
 *
 * Returns the path written, or null if today's backup already existed.
 */
export function runBackup(now: Date = new Date()): string | null {
  const dir = getBackupDir();
  fs.mkdirSync(dir, { recursive: true });

  const target = path.join(dir, `${BACKUP_PREFIX}${localDateStamp(now)}${BACKUP_SUFFIX}`);
  if (fs.existsSync(target)) return null;

  // VACUUM INTO refuses to overwrite, so a half-written file from a crash would block every
  // later attempt. Write to a temp name and rename, which is atomic on the same volume.
  const temp = `${target}.partial`;
  if (fs.existsSync(temp)) fs.unlinkSync(temp);

  db.prepare('VACUUM INTO ?').run(temp);
  fs.renameSync(temp, target);

  return target;
}

/**
 * Deletes backups older than the retention window. Only touches files this module named.
 * Returns how many were removed.
 */
export function pruneBackups(now: Date = new Date()): number {
  const dir = getBackupDir();
  if (!fs.existsSync(dir)) return 0;

  const cutoff = now.getTime() - config.backupRetentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const name of fs.readdirSync(dir)) {
    const match = BACKUP_PATTERN.exec(name);
    if (!match) continue;

    // Compare at end-of-day so a backup is never dropped early by a few hours.
    const taken = new Date(`${match[1]}T23:59:59`).getTime();
    if (Number.isNaN(taken) || taken >= cutoff) continue;

    try {
      fs.unlinkSync(path.join(dir, name));
      removed++;
    } catch (err) {
      logger.warn(`Could not delete old backup ${name}:`, err);
    }
  }

  return removed;
}

/**
 * One backup cycle: write today's snapshot if missing, then prune old ones.
 * Safe to call repeatedly — it's a no-op once today's file exists.
 */
export function backupTick(): void {
  if (!config.backupEnabled) return;

  try {
    const written = runBackup();
    if (written) {
      const sizeKb = Math.round(fs.statSync(written).size / 1024);
      const pruned = pruneBackups();
      logger.info(
        `Database backed up to ${path.basename(written)} (${sizeKb} KB)` +
          (pruned > 0 ? `, removed ${pruned} backup(s) past the ${config.backupRetentionDays}-day window.` : '.')
      );
    }
  } catch (err) {
    // A failed backup must never take the bot down.
    logger.error('Database backup failed:', err);
  }
}

/**
 * Runs a backup now, then hourly. Hourly rather than daily so the schedule survives
 * restarts — the tick is a no-op unless today's file is missing.
 */
export function startBackupSchedule(): NodeJS.Timeout | null {
  if (!config.backupEnabled) {
    logger.info('Database backups are disabled (BACKUP_ENABLED=false).');
    return null;
  }

  backupTick();
  return setInterval(backupTick, 60 * 60 * 1000);
}
