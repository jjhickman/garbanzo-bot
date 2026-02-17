/**
 * Database initialization, schema, and instance management.
 *
 * This module owns the SQLite database handle and all CREATE TABLE statements.
 * Other db-* modules import `db` from here to create prepared statements.
 */

import Database from 'better-sqlite3';
import { resolve } from 'path';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { logger } from '../middleware/logger.js';
import { PROJECT_ROOT, config } from './config.js';

function isTestRuntime(): boolean {
  // Vitest runs tests in multiple node processes by default; having all workers
  // share a single sqlite file causes WAL/journal-mode contention and SQLITE_BUSY
  // flakiness in CI.
  return process.env.NODE_ENV === 'test'
    || Boolean(process.env.VITEST)
    || Boolean(process.env.VITEST_POOL_ID)
    || Boolean(process.env.VITEST_WORKER_ID)
    || Boolean(process.env.JEST_WORKER_ID);
}

export const DB_DIR = isTestRuntime()
  ? resolve(tmpdir(), 'garbanzo-bot-tests', String(process.pid))
  : resolve(PROJECT_ROOT, 'data');

export const DB_PATH = resolve(DB_DIR, 'garbanzo.db');

if (config.DB_DIALECT !== 'sqlite') {
  logger.error({ dialect: config.DB_DIALECT }, 'Unsupported DB dialect (only sqlite is implemented)');
  throw new Error('DB_DIALECT is set to a non-sqlite dialect, but only sqlite is implemented in this build');
}

// Ensure data directory exists
mkdirSync(DB_DIR, { recursive: true });

// Set a connection-level busy timeout early to reduce SQLITE_BUSY flakiness
// when multiple processes/modules open the DB concurrently (common in tests/CI).
const db: InstanceType<typeof Database> = new Database(DB_PATH, { timeout: 5000 });

// Performance pragmas
// NOTE: busy_timeout should be set before attempting journal_mode switches.
db.pragma('busy_timeout = 5000');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

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

  CREATE TABLE IF NOT EXISTS conversation_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL,
    participants TEXT NOT NULL DEFAULT '[]',
    summary_text TEXT,
    topic_tags TEXT NOT NULL DEFAULT '[]',
    summary_version INTEGER NOT NULL DEFAULT 1,
    summary_created_at INTEGER,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'closed', 'summarized', 'failed'))
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_chat_end
    ON conversation_sessions (chat_jid, ended_at DESC);

  CREATE INDEX IF NOT EXISTS idx_sessions_chat_status
    ON conversation_sessions (chat_jid, status);

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
