#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const PROJECT_ROOT = resolve(new URL('..', import.meta.url).pathname);

function parseArgs(argv) {
  const args = {
    version: '',
    skipCheck: false,
    allowDirty: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--version' && argv[i + 1]) {
      args.version = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith('--version=')) {
      args.version = token.slice('--version='.length);
      continue;
    }
    if (token === '--skip-check') {
      args.skipCheck = true;
      continue;
    }
    if (token === '--allow-dirty') {
      args.allowDirty = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  process.stdout.write([
    'Garbanzo release planner (dry-run validator)',
    '',
    'Usage:',
    '  npm run release:plan',
    '  npm run release:plan -- --version=0.2.0',
    '  npm run release:plan -- --version=v0.2.0 --skip-check',
    '',
    'Flags:',
    '  --version <semver>  Target release version (must match package.json)',
    '  --skip-check        Skip running npm run check',
    '  --allow-dirty       Allow dirty git working tree',
  ].join('\n'));
}

function run(command, description) {
  process.stdout.write(`\n▶ ${description}\n`);
  return execSync(command, {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    encoding: 'utf-8',
  }).trim();
}

function fail(message) {
  process.stderr.write(`\n❌ ${message}\n`);
  process.exit(1);
}

function normalizeVersion(raw) {
  const value = raw.trim();
  return value.startsWith('v') ? value.slice(1) : value;
}

function isSemverLike(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const packageJsonPath = resolve(PROJECT_ROOT, 'package.json');
  const changelogPath = resolve(PROJECT_ROOT, 'CHANGELOG.md');
  const dockerWorkflowPath = resolve(PROJECT_ROOT, '.github', 'workflows', 'release-docker.yml');
  const nativeWorkflowPath = resolve(PROJECT_ROOT, '.github', 'workflows', 'release-native-binaries.yml');

  if (!existsSync(packageJsonPath)) fail('package.json not found');
  if (!existsSync(changelogPath)) fail('CHANGELOG.md not found');
  if (!existsSync(dockerWorkflowPath)) fail('.github/workflows/release-docker.yml not found');
  if (!existsSync(nativeWorkflowPath)) fail('.github/workflows/release-native-binaries.yml not found');

  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const packageVersion = normalizeVersion(String(pkg.version ?? '').trim());
  if (!packageVersion || !isSemverLike(packageVersion)) {
    fail(`package.json version is invalid: ${pkg.version ?? '(missing)'}`);
  }

  const targetVersion = args.version ? normalizeVersion(args.version) : packageVersion;
  if (!isSemverLike(targetVersion)) {
    fail(`Provided version is not semver-like: ${args.version}`);
  }

  if (targetVersion !== packageVersion) {
    fail(`Version mismatch: package.json=${packageVersion}, requested=${targetVersion}. Update package.json first (npm version ...).`);
  }

  const currentBranch = run('git branch --show-current', 'Checking current branch');
  if (currentBranch !== 'main') {
    fail(`Release planning must run on main (current: ${currentBranch})`);
  }

  if (!args.allowDirty) {
    const dirty = run('git status --porcelain', 'Checking git working tree');
    if (dirty.length > 0) {
      fail('Working tree is not clean. Commit/stash changes or re-run with --allow-dirty.');
    }
  }

  const localTagExists = run(`git tag -l "v${targetVersion}"`, 'Checking existing local tag').length > 0;
  if (localTagExists) {
    fail(`Tag v${targetVersion} already exists locally.`);
  }

  const remoteTagExists = run(`git ls-remote --tags origin "refs/tags/v${targetVersion}"`, 'Checking existing remote tag').length > 0;
  if (remoteTagExists) {
    fail(`Tag v${targetVersion} already exists on origin.`);
  }

  const changelog = readFileSync(changelogPath, 'utf-8');
  if (!changelog.includes('## [Unreleased]')) {
    fail('CHANGELOG.md must include ## [Unreleased] section before release.');
  }

  if (!args.skipCheck) {
    process.stdout.write('\n▶ Running full quality gate (npm run check)\n');
    execSync('npm run check', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  }

  process.stdout.write('\n▶ Checking open Dependabot PRs\n');
  const dependabotRaw = execSync(
    'gh pr list --state open --base main --search "author:app/dependabot" --json number,title,url',
    { cwd: PROJECT_ROOT, stdio: 'pipe', encoding: 'utf-8' },
  );
  const dependabot = JSON.parse(dependabotRaw);
  if (Array.isArray(dependabot) && dependabot.length > 0) {
    process.stdout.write('⚠ Open Dependabot PRs found:\n');
    for (const pr of dependabot) {
      process.stdout.write(`  - #${pr.number}: ${pr.title} (${pr.url})\n`);
    }
    fail('Resolve Dependabot queue before publishing a release tag.');
  }

  process.stdout.write('\n✅ Release dry-run checks passed\n');
  process.stdout.write('\nSuggested next steps:\n');
  process.stdout.write(`  npm version patch   # or minor/major (current ${packageVersion})\n`);
  process.stdout.write('  git push origin main --follow-tags\n');
  process.stdout.write('  # verify Release Docker Image + Release Native Binaries workflows\n');
}

main();
