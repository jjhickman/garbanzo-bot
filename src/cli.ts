#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { processPrinter, type CliPrinter } from './cli/cli-print.js';

export type CliCommand =
  | { kind: 'setup'; args: string[] }
  | { kind: 'start' }
  | { kind: 'doctor' }
  | { kind: 'service'; action: 'install' | 'uninstall'; force: boolean; system: boolean }
  | { kind: 'help'; exitCode: 0 | 1; error?: string }
  | { kind: 'version' };

function helpText(): string {
  return [
    'Usage: garbanzo <command>',
    '',
    'Commands:',
    '  setup                 Run the setup wizard',
    '  start                 Start the bot runtime',
    '  doctor                Print an environment report',
    '  service install       Write a systemd user unit or launchd agent',
    '  service uninstall     Remove the generated systemd unit or launchd agent',
    '  --help                Show this help',
    '  --version             Print the package version',
    '',
  ].join('\n');
}

export function parseCliCommand(args: string[]): CliCommand {
  const [command, ...rest] = args;

  if (!command || command === '--help' || command === '-h') {
    return { kind: 'help', exitCode: 0 };
  }
  if (command === '--version' || command === '-v') {
    return { kind: 'version' };
  }
  if (command === 'setup') {
    return { kind: 'setup', args: rest };
  }
  if (command === 'start') {
    return { kind: 'start' };
  }
  if (command === 'doctor') {
    return { kind: 'doctor' };
  }
  if (command === 'service') {
    const action = rest.find((arg) => arg !== '--force' && arg !== '--system');
    if (action !== 'install' && action !== 'uninstall') {
      return { kind: 'help', exitCode: 1, error: 'Usage: garbanzo service install|uninstall' };
    }
    return {
      kind: 'service',
      action,
      force: rest.includes('--force'),
      system: rest.includes('--system'),
    };
  }

  return { kind: 'help', exitCode: 1, error: `Unknown command: ${command}` };
}

async function packageVersion(): Promise<string> {
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const packagePath = resolve(cliDir, '..', 'package.json');
  try {
    const json = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: string };
    return json.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function spawnSetup(setupPath: string, args: string[]): Promise<number> {
  return new Promise((resolveSpawn, reject) => {
    const child = spawn(process.execPath, [setupPath, ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        resolveSpawn(1);
        return;
      }
      resolveSpawn(code ?? 0);
    });
  });
}

function resolveMode(garbanzoHome: string | undefined, packaged: boolean): 'repo' | 'packaged' | 'env-set' {
  if (garbanzoHome?.trim()) return 'env-set';
  return packaged ? 'packaged' : 'repo';
}

export async function runCli(args: string[] = process.argv.slice(2), printer: CliPrinter = processPrinter): Promise<number> {
  const parsed = parseCliCommand(args);

  if (parsed.kind === 'help') {
    if (parsed.error) printer.stderr(`${parsed.error}\n\n`);
    printer.stdout(helpText());
    return parsed.exitCode;
  }

  if (parsed.kind === 'version') {
    printer.stdout(`${await packageVersion()}\n`);
    return 0;
  }

  if (parsed.kind === 'start') {
    await import('./index.js');
    return 0;
  }

  if (parsed.kind === 'setup') {
    const { assetPath } = await import('./utils/paths.js');
    return spawnSetup(assetPath('scripts', 'setup.mjs'), parsed.args);
  }

  if (parsed.kind === 'doctor') {
    const [{ collectDoctorReport, formatDoctorReport }, { GARBANZO_HOME_DIR, PACKAGE_ROOT, isPackagedInstall }] = await Promise.all([
      import('./cli/doctor.js'),
      import('./utils/paths.js'),
    ]);
    const report = await collectDoctorReport({
      packageRoot: PACKAGE_ROOT,
      homeDir: GARBANZO_HOME_DIR,
      mode: resolveMode(process.env.GARBANZO_HOME, isPackagedInstall()),
    });
    printer.stdout(formatDoctorReport(report));
    return report.node.ok ? 0 : 1;
  }

  const [{ runServiceCommand }, { assetPath, GARBANZO_HOME_DIR, PACKAGE_ROOT }] = await Promise.all([
    import('./cli/service-install.js'),
    import('./utils/paths.js'),
  ]);

  return runServiceCommand({
    action: parsed.action,
    force: parsed.force,
    system: parsed.system,
    packageRoot: PACKAGE_ROOT,
    homeDir: GARBANZO_HOME_DIR,
    templatePath: assetPath('scripts', 'garbanzo.service'),
  }, printer);
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((err: unknown) => {
    process.stderr.write(`garbanzo: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

