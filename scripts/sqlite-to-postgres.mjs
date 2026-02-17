#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import Database from 'better-sqlite3';
import { Client } from 'pg';

const root = process.cwd();
const sqlitePath = process.env.SQLITE_PATH
  ? resolve(root, process.env.SQLITE_PATH)
  : resolve(root, 'data', 'garbanzo.db');
const schemaPath = resolve(root, 'src', 'utils', 'postgres-schema.sql');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required (postgres://...)');
  process.exit(1);
}

if (!existsSync(sqlitePath)) {
  console.error(`SQLite database not found: ${sqlitePath}`);
  process.exit(1);
}

if (!existsSync(schemaPath)) {
  console.error(`Postgres schema file not found: ${schemaPath}`);
  process.exit(1);
}

function parseJsonArray(value, fallback = []) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
const pg = new Client({ connectionString: databaseUrl });

const schemaSql = readFileSync(schemaPath, 'utf-8');

const tables = {
  messages: sqlite.prepare('SELECT id, chat_jid, sender, text, timestamp FROM messages').all(),
  moderation_log: sqlite.prepare('SELECT id, chat_jid, sender, text, reason, severity, source, timestamp FROM moderation_log').all(),
  daily_stats: sqlite.prepare('SELECT id, date, data FROM daily_stats').all(),
  memory: sqlite.prepare('SELECT id, fact, category, source, created_at FROM memory').all(),
  member_profiles: sqlite.prepare('SELECT jid, name, interests, groups_active, event_count, first_seen, last_seen, opted_in FROM member_profiles').all(),
  feedback: sqlite.prepare('SELECT id, type, sender, group_jid, text, status, upvotes, upvoters, github_issue_number, github_issue_url, github_issue_created_at, timestamp FROM feedback').all(),
};

try {
  await pg.connect();
  await pg.query('BEGIN');
  await pg.query(schemaSql);

  for (const row of tables.messages) {
    await pg.query(
      `INSERT INTO messages (id, chat_jid, sender, text, timestamp)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.chat_jid, row.sender, row.text, row.timestamp],
    );
  }

  for (const row of tables.moderation_log) {
    await pg.query(
      `INSERT INTO moderation_log (id, chat_jid, sender, text, reason, severity, source, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.chat_jid, row.sender, row.text, row.reason, row.severity, row.source, row.timestamp],
    );
  }

  for (const row of tables.daily_stats) {
    await pg.query(
      `INSERT INTO daily_stats (id, date, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (date) DO UPDATE SET data = EXCLUDED.data`,
      [row.id, row.date, row.data],
    );
  }

  for (const row of tables.memory) {
    await pg.query(
      `INSERT INTO memory (id, fact, category, source, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.fact, row.category, row.source, row.created_at],
    );
  }

  for (const row of tables.member_profiles) {
    await pg.query(
      `INSERT INTO member_profiles (jid, name, interests, groups_active, event_count, first_seen, last_seen, opted_in)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8)
       ON CONFLICT (jid) DO UPDATE SET
         name = EXCLUDED.name,
         interests = EXCLUDED.interests,
         groups_active = EXCLUDED.groups_active,
         event_count = EXCLUDED.event_count,
         first_seen = EXCLUDED.first_seen,
         last_seen = EXCLUDED.last_seen,
         opted_in = EXCLUDED.opted_in`,
      [
        row.jid,
        row.name,
        JSON.stringify(parseJsonArray(row.interests)),
        JSON.stringify(parseJsonArray(row.groups_active)),
        row.event_count,
        row.first_seen,
        row.last_seen,
        row.opted_in,
      ],
    );
  }

  for (const row of tables.feedback) {
    await pg.query(
      `INSERT INTO feedback (
         id, type, sender, group_jid, text, status, upvotes, upvoters,
         github_issue_number, github_issue_url, github_issue_created_at, timestamp
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         type = EXCLUDED.type,
         sender = EXCLUDED.sender,
         group_jid = EXCLUDED.group_jid,
         text = EXCLUDED.text,
         status = EXCLUDED.status,
         upvotes = EXCLUDED.upvotes,
         upvoters = EXCLUDED.upvoters,
         github_issue_number = EXCLUDED.github_issue_number,
         github_issue_url = EXCLUDED.github_issue_url,
         github_issue_created_at = EXCLUDED.github_issue_created_at,
         timestamp = EXCLUDED.timestamp`,
      [
        row.id,
        row.type,
        row.sender,
        row.group_jid,
        row.text,
        row.status,
        row.upvotes,
        JSON.stringify(parseJsonArray(row.upvoters)),
        row.github_issue_number,
        row.github_issue_url,
        row.github_issue_created_at,
        row.timestamp,
      ],
    );
  }

  await pg.query('COMMIT');

  console.log('SQLite -> Postgres migration complete.');
  console.log(`Source: ${sqlitePath}`);
  console.log(`Imported rows:`);
  console.log(`  messages: ${tables.messages.length}`);
  console.log(`  moderation_log: ${tables.moderation_log.length}`);
  console.log(`  daily_stats: ${tables.daily_stats.length}`);
  console.log(`  memory: ${tables.memory.length}`);
  console.log(`  member_profiles: ${tables.member_profiles.length}`);
  console.log(`  feedback: ${tables.feedback.length}`);
} catch (err) {
  await pg.query('ROLLBACK').catch(() => undefined);
  console.error('Migration failed.');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  sqlite.close();
  await pg.end().catch(() => undefined);
}
