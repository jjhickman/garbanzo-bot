#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const sourceRunner = resolve(projectRoot, 'src', 'cli', 'setup', 'run.ts');
const compiledRunner = resolve(projectRoot, 'dist', 'cli', 'setup', 'run.js');

if (existsSync(tsxCli)) {
  await import('tsx/esm');
  await import(pathToFileURL(sourceRunner).href);
} else {
  await import(pathToFileURL(compiledRunner).href);
}
