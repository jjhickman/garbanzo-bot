import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FIELD_TABLE } from '../../config-core/fields.js';

const SPECIAL_FIELDS: Record<string, string> = {
  MESSAGING_PLATFORM: 'platform',
  OPENAI_AUTH_MODE: 'openai-auth-mode',
  COMPOSE_PROFILES: 'compose-profiles',
  DEPLOY_TARGET: 'deploy',
};

function fieldArgs(fields: Record<string, unknown>): string[] {
  const byEnv = new Map(FIELD_TABLE.map((field) => [field.env, field.cli]));
  return Object.entries(fields).flatMap(([key, value]) => {
    if (value === undefined || value === null) return [];
    if (key === 'AI_PROVIDER_ORDER') {
      return [`--providers=${String(value)}`, `--provider-order=${String(value)}`];
    }
    const cli = byEnv.get(key) ?? SPECIAL_FIELDS[key] ?? key.replace(/_/g, '-').toLowerCase();
    return [`--${cli}=${String(value)}`];
  });
}

export async function runWizard(root: string, payload: { fields?: Record<string, unknown>; args?: string[] }): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const compiled = fileURLToPath(new URL('../setup/run.js', import.meta.url));
  const source = fileURLToPath(new URL('../setup/run.ts', import.meta.url));
  const runner = existsSync(compiled) ? compiled : source;
  const args = ['--non-interactive', ...(payload.args ?? fieldArgs(payload.fields ?? {}))];
  const nodeArgs = runner.endsWith('.ts') ? ['--import', 'tsx', runner, ...args] : [runner, ...args];
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      env: { ...process.env, GARBANZO_HOME: root, GARBANZO_CLI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolveRun({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}
