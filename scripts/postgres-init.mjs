#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { Client } from 'pg';

const root = process.cwd();
const schemaPath = resolve(root, 'src', 'utils', 'postgres-schema.sql');
const schemaSql = readFileSync(schemaPath, 'utf-8');

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required (postgres://...)');
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(schemaSql);
  console.log('Postgres schema initialized successfully.');
} catch (err) {
  console.error('Failed to initialize Postgres schema.');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  await client.end().catch(() => undefined);
}
