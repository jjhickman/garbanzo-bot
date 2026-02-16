#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const PACKAGE_JSON = resolve(PROJECT_ROOT, 'package.json');

function printHelp() {
  process.stdout.write([
    'Garbanzo release checklist helper',
    '',
    'Usage:',
    '  npm run release:checklist -- --version=0.1.6',
    '  npm run release:checklist -- --version=v0.1.6 --assignees=jjhickman,garbanzo-dev',
    '',
    'Flags:',
    '  --version <semver>    Target release version (required; v-prefix optional)',
    '  --assignees <csv>     Issue assignees (default: jjhickman,garbanzo-dev)',
    '  --help                Show this help',
    '',
    'Behavior:',
    '  - Ensures release label exists',
    '  - Creates [release] vX.Y.Z checklist issue',
    '  - Adds release label and assignees',
  ].join('\n'));
}

function parseArgs(argv) {
  const out = {
    version: '',
    assignees: 'jjhickman,garbanzo-dev',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }

    if (token === '--version' && argv[i + 1]) {
      out.version = argv[i + 1];
      i += 1;
      continue;
    }

    if (token.startsWith('--version=')) {
      out.version = token.slice('--version='.length);
      continue;
    }

    if (token === '--assignees' && argv[i + 1]) {
      out.assignees = argv[i + 1];
      i += 1;
      continue;
    }

    if (token.startsWith('--assignees=')) {
      out.assignees = token.slice('--assignees='.length);
      continue;
    }
  }

  return out;
}

function normalizeVersion(value) {
  const trimmed = String(value || '').trim();
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

function isSemverLike(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function runGh(args) {
  return execFileSync('gh', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function ensureReleaseLabel() {
  try {
    runGh(['label', 'create', 'release', '--description', 'Release tracking tasks', '--color', '0E8A16']);
  } catch (err) {
    const msg = String(err?.stderr || err?.message || '');
    if (msg.includes('already exists')) return;
    throw err;
  }
}

function getPackageVersion() {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  return normalizeVersion(pkg.version || '');
}

function buildBody(version) {
  return [
    '## Version',
    version,
    '',
    '## Pre-release quality gate',
    '- [ ] `npm run check` passes on local main',
    '- [ ] Dependabot queue reviewed (`npm run gh:dependabot`)',
    '- [ ] `CHANGELOG.md` updated for this release',
    '- [ ] Docs updates complete (`README.md`, `docs/RELEASES.md`, relevant feature docs)',
    '',
    '## Tag and publish',
    '- [ ] Bump version (`npm version patch|minor|major --no-git-tag-version`)',
    '- [ ] Merge version PR into `main`, then push release tag (`git push origin vX.Y.Z`)',
    '- [ ] Confirm `Release Docker Image` workflow success',
    '- [ ] Confirm `Release Native Binaries` workflow success',
    '',
    '## Deploy and verify',
    '- [ ] Deploy image with `APP_VERSION`',
    '- [ ] Health endpoint responds after deploy',
    '- [ ] Owner DM `!release` broadcast sent with expected version',
    '- [ ] Rollback plan prepared/documented',
    '',
    '## Release notes / rollout notes',
    '- ',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = normalizeVersion(args.version || getPackageVersion());

  if (!version || !isSemverLike(version)) {
    process.stderr.write('❌ Provide a valid --version (example: 0.1.6)\n');
    process.exit(1);
  }

  const assignees = String(args.assignees || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  ensureReleaseLabel();

  const ghArgs = [
    'issue',
    'create',
    '--title',
    `[release] v${version} checklist`,
    '--label',
    'release',
    '--body',
    buildBody(version),
  ];

  for (const assignee of assignees) {
    ghArgs.push('--assignee', assignee);
  }

  const url = runGh(ghArgs);
  process.stdout.write(`${url}\n`);
}

main();
