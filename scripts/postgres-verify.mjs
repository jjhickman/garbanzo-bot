#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import Database from 'better-sqlite3';
import { Client } from 'pg';

const TABLES = [
  'messages',
  'moderation_log',
  'daily_stats',
  'memory',
  'member_profiles',
  'feedback',
];

const root = process.cwd();
const databaseUrl = process.env.DATABASE_URL;
const sqlitePath = process.env.SQLITE_PATH
  ? resolve(root, process.env.SQLITE_PATH)
  : resolve(root, 'data', 'garbanzo.db');

if (!databaseUrl) {
  console.error('DATABASE_URL is required (postgres://...)');
  process.exit(1);
}

async function getPostgresCounts(client) {
  const counts = {};

  for (const table of TABLES) {
    const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${table}`);
    const raw = result.rows[0]?.count;
    const count = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '0'), 10);
    counts[table] = Number.isFinite(count) ? count : 0;
  }

  return counts;
}

function getSqliteCounts(path) {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });

  try {
    const counts = {};
    for (const table of TABLES) {
      const row = sqlite.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
      counts[table] = Number(row?.count ?? 0);
    }
    return counts;
  } finally {
    sqlite.close();
  }
}

function printCounts(label, counts) {
  console.log(`${label}:`);
  for (const table of TABLES) {
    console.log(`  ${table}: ${counts[table]}`);
  }
}

const pg = new Client({ connectionString: databaseUrl });

try {
  await pg.connect();
  const pgCounts = await getPostgresCounts(pg);

  console.log('Post-migration verification report');
  printCounts('Postgres row counts', pgCounts);

  if (!existsSync(sqlitePath)) {
    console.log(`SQLite source file not found at ${sqlitePath}. Skipping cross-check.`);
    process.exit(0);
  }

  const sqliteCounts = getSqliteCounts(sqlitePath);
  printCounts('SQLite row counts', sqliteCounts);

  const mismatches = TABLES
    .map((table) => ({ table, sqlite: sqliteCounts[table], postgres: pgCounts[table] }))
    .filter((item) => item.sqlite !== item.postgres);

  if (mismatches.length > 0) {
    console.error('Verification failed: row count mismatches detected.');
    for (const mismatch of mismatches) {
      console.error(`  ${mismatch.table}: sqlite=${mismatch.sqlite}, postgres=${mismatch.postgres}`);
    }
    process.exit(1);
  }

  console.log('Verification passed: SQLite and Postgres row counts match.');
} catch (err) {
  console.error('Verification failed due to an error.');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  await pg.end().catch(() => undefined);
}
