import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseDotenv } from 'dotenv';

import { isSecretKey } from '../../config-core/secret-classifier.js';
import { writeFileWithBackupAtomic } from '../../config-core/writers.js';

export const ENV_FILE_NAMES = ['.env', '.env.discord', '.env.whatsapp', '.env.telegram', '.env.matrix'] as const;
export type EnvFileName = (typeof ENV_FILE_NAMES)[number];

export type EnvSnapshot = {
  values: Record<string, string>;
  masked: Record<string, string | { set: boolean }>;
  mtimeMs: number;
  fileMtimes: Record<string, number | null>;
};

export function readEnvSnapshot(root: string): EnvSnapshot {
  const values: Record<string, string> = {};
  const fileMtimes: Record<string, number | null> = {};
  let mtimeMs = 0;
  for (const name of ENV_FILE_NAMES) {
    const path = resolve(root, name);
    if (!existsSync(path)) {
      fileMtimes[name] = null;
      continue;
    }
    const mtime = statSync(path).mtimeMs;
    fileMtimes[name] = mtime;
    mtimeMs = Math.max(mtimeMs, mtime);
    Object.assign(values, parseDotenv(readFileSync(path, 'utf8')));
  }
  const masked = Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    isSecretKey(key) ? { set: value.length > 0 } : value,
  ]));
  return { values, masked, mtimeMs, fileMtimes };
}

function replaceEnvValues(content: string, update: Record<string, string | null>): string {
  const remaining = new Map(Object.entries(update));
  const hadNewline = content.endsWith('\n');
  const lines = content.length === 0 ? [] : content.replace(/\n$/, '').split('\n');
  const rewritten = lines.map((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)/);
    const key = match?.[2];
    if (!key || !remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${match[1]}${key}${match[3]}${value ?? ''}`;
  });
  for (const [key, value] of remaining) rewritten.push(`${key}=${value ?? ''}`);
  return `${rewritten.join('\n')}${hadNewline || rewritten.length > 0 ? '\n' : ''}`;
}

function targetForKey(root: string, key: string, values: Record<string, string>): string {
  const platform = (values.MESSAGING_PLATFORM ?? '').toLowerCase();
  const prefixes: Record<string, string[]> = {
    discord: ['DISCORD_', 'BAND_'],
    whatsapp: ['WHATSAPP_', 'OWNER_JID', 'BOT_PHONE_NUMBER'],
    telegram: ['TELEGRAM_'],
    matrix: ['MATRIX_'],
  };
  if (platform && (prefixes[platform] ?? []).some((prefix) => key === prefix || key.startsWith(prefix))) {
    return resolve(root, `.env.${platform}`);
  }
  for (const name of ENV_FILE_NAMES) {
    const path = resolve(root, name);
    if (existsSync(path) && Object.hasOwn(parseDotenv(readFileSync(path, 'utf8')), key)) return path;
  }
  return resolve(root, '.env');
}

export function writeEnvUpdate(root: string, update: Record<string, string | null>, current: EnvSnapshot): void {
  const byPath = new Map<string, Record<string, string | null>>();
  for (const [key, value] of Object.entries(update)) {
    const path = targetForKey(root, key, current.values);
    const entries = byPath.get(path) ?? {};
    entries[key] = value;
    byPath.set(path, entries);
  }
  for (const [path, entries] of byPath) {
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
    writeFileWithBackupAtomic(path, replaceEnvValues(existing, entries));
  }
}
