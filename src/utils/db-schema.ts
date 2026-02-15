/**
 * Database initialization, schema, and instance management.
 *
 * This module owns the SQLite database handle and all CREATE TABLE statements.
 * Other db-* modules import `db` from here to create prepared statements.
 */

import Database from 'better-sqlite3';
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import { logger } from '../middleware/logger.js';
import { PROJECT_ROOT } from './config.js';

export const DB_DIR = resolve(PROJECT_ROOT, 'data');
export const DB_PATH = resolve(DB_DIR, 'garbanzo.db');

// Ensure data directory exists
mkdirSync(DB_DIR, { recursive: true });

const db: InstanceType<typeof Database> = new Database(DB_PATH);

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

logger.info({ path: DB_PATH }, 'SQLite database opened');

// ── Schema ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_ts
    ON messages (chat_jid, timestamp DESC);

  CREATE TABLE IF NOT EXISTS moderation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    sender TEXT NOT NULL,
    text TEXT NOT NULL,
    reason TEXT NOT NULL,
    severity TEXT NOT NULL,
    source TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_moderation_ts
    ON moderation_log (timestamp DESC);

  CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fact TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    source TEXT NOT NULL DEFAULT 'owner',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_category
    ON memory (category);

  CREATE TABLE IF NOT EXISTS member_profiles (
    jid TEXT PRIMARY KEY,
    name TEXT,
    interests TEXT NOT NULL DEFAULT '[]',
    groups_active TEXT NOT NULL DEFAULT '[]',
    event_count INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    opted_in INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('suggestion', 'bug')),
    sender TEXT NOT NULL,
    group_jid TEXT,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected', 'done')),
    upvotes INTEGER NOT NULL DEFAULT 0,
    upvoters TEXT NOT NULL DEFAULT '[]',
    github_issue_number INTEGER,
    github_issue_url TEXT,
    github_issue_created_at INTEGER,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_feedback_status
    ON feedback (status, timestamp DESC);
`);

interface TableColumnInfo {
  name: string;
}

function tableHasColumn(table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
  return rows.some((row) => row.name === column);
}

// Forward-compatible migration for older databases created before feedback issue-link columns.
if (!tableHasColumn('feedback', 'github_issue_number')) {
  db.exec('ALTER TABLE feedback ADD COLUMN github_issue_number INTEGER');
}
if (!tableHasColumn('feedback', 'github_issue_url')) {
  db.exec('ALTER TABLE feedback ADD COLUMN github_issue_url TEXT');
}
if (!tableHasColumn('feedback', 'github_issue_created_at')) {
  db.exec('ALTER TABLE feedback ADD COLUMN github_issue_created_at INTEGER');
}

// ── Cleanup ─────────────────────────────────────────────────────────

/**
 * Close the raw database handle. The barrel db.ts wraps this with
 * stopMaintenance() to form the public closeDb().
 */
export function closeDbHandle(): void {
  db.close();
  logger.info('SQLite database closed');
}

export { db };
