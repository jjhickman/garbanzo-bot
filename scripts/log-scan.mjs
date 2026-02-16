#!/usr/bin/env node
/*
  Lightweight log scanner for Garbanzo (Pino JSON logs).

  Usage:
    node scripts/log-scan.mjs /path/to/log.jsonl
    node scripts/log-scan.mjs /path/to/log.jsonl --min-level warn --top 15

  Notes:
  - Expects one JSON object per line (Pino default).
  - Skips non-JSON lines safely.
*/

import fs from 'node:fs';
import readline from 'node:readline';

function usage(exitCode = 1) {
  // Intentionally plain text (CLI tool output).
  // eslint-disable-next-line no-console
  console.log(`Usage: node scripts/log-scan.mjs <logfile> [--min-level <info|warn|error|fatal>] [--top <N>]

Examples:
  node scripts/log-scan.mjs ./logs/garbanzo.log
  node scripts/log-scan.mjs ./logs/garbanzo.log --min-level error --top 20

Tip: if you run via npm, pass args after --
  npm run logs:scan -- ./logs/garbanzo.log --min-level warn
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = { file: null, minLevel: 'warn', top: 10 };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;

    if (a === '-h' || a === '--help') usage(0);

    if (a === '--min-level') {
      out.minLevel = argv[i + 1] ?? '';
      i++;
      continue;
    }

    if (a.startsWith('--min-level=')) {
      out.minLevel = a.split('=')[1] ?? '';
      continue;
    }

    if (a === '--top') {
      out.top = Number(argv[i + 1] ?? '');
      i++;
      continue;
    }

    if (a.startsWith('--top=')) {
      out.top = Number(a.split('=')[1] ?? '');
      continue;
    }

    if (a.startsWith('-')) {
      // Unknown flag
      usage(1);
    }

    if (!out.file) out.file = a;
  }

  if (!out.file) usage(1);
  if (!Number.isFinite(out.top) || out.top <= 0) out.top = 10;

  return out;
}

const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function resolveMinLevel(name) {
  const key = String(name ?? '').trim().toLowerCase();
  const v = LEVELS[key];
  if (!v) return null;
  return v;
}

function bestMessage(obj) {
  const msg = obj?.msg ?? obj?.message;
  if (typeof msg === 'string' && msg.trim()) return msg.trim();

  const err = obj?.err;
  const errMsg = err?.message;
  if (typeof errMsg === 'string' && errMsg.trim()) return `err: ${errMsg.trim()}`;

  const errType = err?.type;
  if (typeof errType === 'string' && errType.trim()) return `errType: ${errType.trim()}`;

  return '(no msg)';
}

function bestWhen(obj) {
  // Pino typically has `time` as epoch milliseconds.
  const t = obj?.time;
  if (typeof t === 'number' && Number.isFinite(t)) {
    try {
      return new Date(t).toISOString();
    } catch {
      return null;
    }
  }

  // Some logs might include ISO strings.
  const ts = obj?.timestamp;
  if (typeof ts === 'string' && ts.trim()) return ts.trim();

  return null;
}

async function main() {
  const { file, minLevel, top } = parseArgs(process.argv.slice(2));
  const min = resolveMinLevel(minLevel);
  if (!min) usage(1);

  if (!fs.existsSync(file)) {
    // eslint-disable-next-line no-console
    console.error(`File not found: ${file}`);
    process.exit(2);
  }

  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let totalLines = 0;
  let parsed = 0;
  let skipped = 0;
  let matched = 0;

  const levelCounts = new Map();
  const msgCounts = new Map();
  const samples = [];

  for await (const line of rl) {
    totalLines++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
      parsed++;
    } catch {
      skipped++;
      continue;
    }

    const lvl = obj?.level;
    if (typeof lvl !== 'number') continue;
    if (lvl < min) continue;

    matched++;

    const levelKey = String(lvl);
    levelCounts.set(levelKey, (levelCounts.get(levelKey) ?? 0) + 1);

    const msg = bestMessage(obj);
    msgCounts.set(msg, (msgCounts.get(msg) ?? 0) + 1);

    if (samples.length < 5) {
      samples.push({
        when: bestWhen(obj),
        level: lvl,
        msg,
      });
    }
  }

  const sortedMsgs = [...msgCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);

  // eslint-disable-next-line no-console
  console.log(`Log scan results: ${file}`);
  // eslint-disable-next-line no-console
  console.log(`- Lines: ${totalLines}, parsed JSON: ${parsed}, skipped: ${skipped}`);
  // eslint-disable-next-line no-console
  console.log(`- Matched level >= ${min} (${minLevel}): ${matched}`);

  // eslint-disable-next-line no-console
  console.log('\nLevel counts (numeric):');
  for (const [k, v] of [...levelCounts.entries()].sort((a, b) => Number(b[0]) - Number(a[0]))) {
    // eslint-disable-next-line no-console
    console.log(`- ${k}: ${v}`);
  }

  // eslint-disable-next-line no-console
  console.log(`\nTop ${sortedMsgs.length} messages:`);
  for (const [m, c] of sortedMsgs) {
    // eslint-disable-next-line no-console
    console.log(`- ${c}x ${m}`);
  }

  if (samples.length) {
    // eslint-disable-next-line no-console
    console.log('\nSample entries:');
    for (const s of samples) {
      const when = s.when ? `${s.when} ` : '';
      // eslint-disable-next-line no-console
      console.log(`- ${when}level=${s.level} ${s.msg}`);
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
