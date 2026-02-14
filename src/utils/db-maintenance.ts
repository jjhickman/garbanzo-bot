/**
 * Database maintenance — backup, vacuum, and scheduled cleanup.
 *
 * Handles daily backup creation with retention, age-based message pruning,
 * and scheduled 4 AM maintenance runs.
 */

import { resolve } from 'path';
import { mkdirSync, copyFileSync, readdirSync, unlinkSync } from 'fs';
import { logger } from '../middleware/logger.js';
import { db, DB_DIR, DB_PATH } from './db-schema.js';

// ── Backup ──────────────────────────────────────────────────────────

const BACKUP_DIR = resolve(DB_DIR, 'backups');
const MAX_BACKUPS = 7;

/**
 * Create a backup of the database file.
 * Uses SQLite's VACUUM INTO for a consistent snapshot (WAL-safe).
 * Keeps the last 7 daily backups, prunes older ones.
 */
export function backupDatabase(): string {
  mkdirSync(BACKUP_DIR, { recursive: true });

  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const backupPath = resolve(BACKUP_DIR, `garbanzo-${dateStr}.db`);

  try {
    // VACUUM INTO creates a clean, consistent copy even with WAL mode
    db.exec(`VACUUM INTO '${backupPath}'`);
    logger.info({ backupPath }, 'Database backup created');
  } catch {
    // Fallback to file copy if VACUUM INTO is not supported
    copyFileSync(DB_PATH, backupPath);
    logger.info({ backupPath, method: 'filecopy' }, 'Database backup created (fallback)');
  }

  // Prune old backups beyond retention limit
  try {
    const files = readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('garbanzo-') && f.endsWith('.db'))
      .sort()
      .reverse();

    for (const file of files.slice(MAX_BACKUPS)) {
      unlinkSync(resolve(BACKUP_DIR, file));
      logger.info({ file }, 'Old backup pruned');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to prune old backups');
  }

  return backupPath;
}

// ── Message pruning & vacuum ────────────────────────────────────────

/** Max age for messages in days. Older messages are pruned during vacuum. */
const MESSAGE_RETENTION_DAYS = 30;

const pruneOldByAge = db.prepare(`
  DELETE FROM messages WHERE timestamp < ?
`);

const countMessages = db.prepare(`
  SELECT COUNT(*) as count FROM messages
`);

/**
 * Prune messages older than 30 days, then run VACUUM to reclaim space.
 * Returns stats about what was cleaned.
 */
export function runMaintenance(): { pruned: number; beforeCount: number; afterCount: number } {
  const beforeCount = (countMessages.get() as { count: number }).count;
  const cutoff = Math.floor(Date.now() / 1000) - (MESSAGE_RETENTION_DAYS * 24 * 60 * 60);

  const result = pruneOldByAge.run(cutoff);
  const pruned = result.changes;

  // Only VACUUM if we actually deleted something (VACUUM is expensive)
  if (pruned > 0) {
    db.exec('VACUUM');
  }

  const afterCount = (countMessages.get() as { count: number }).count;

  logger.info({
    pruned,
    beforeCount,
    afterCount,
    retentionDays: MESSAGE_RETENTION_DAYS,
  }, 'Database maintenance complete');

  return { pruned, beforeCount, afterCount };
}

// ── Scheduled maintenance ───────────────────────────────────────────

let maintenanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule daily maintenance at 4 AM local time.
 * Runs once when called, then reschedules itself for the next 4 AM.
 */
export function scheduleMaintenance(): void {
  const now = new Date();
  const next4AM = new Date(now);
  next4AM.setHours(4, 0, 0, 0);

  // If it's already past 4 AM today, schedule for tomorrow
  if (now >= next4AM) {
    next4AM.setDate(next4AM.getDate() + 1);
  }

  const msUntil = next4AM.getTime() - now.getTime();

  maintenanceTimer = setTimeout(() => {
    try {
      backupDatabase();
    } catch (err) {
      logger.error({ err }, 'Database backup failed');
    }
    try {
      runMaintenance();
    } catch (err) {
      logger.error({ err }, 'Database maintenance failed');
    }
    // Reschedule for next day
    scheduleMaintenance();
  }, msUntil);

  logger.info({
    nextRun: next4AM.toISOString(),
    inHours: +(msUntil / 3_600_000).toFixed(1),
  }, 'Database maintenance scheduled');
}

export function stopMaintenance(): void {
  if (maintenanceTimer) {
    clearTimeout(maintenanceTimer);
    maintenanceTimer = null;
  }
}
