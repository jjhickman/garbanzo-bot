#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { processPrinter, type CliPrinter } from './cli/cli-print.js';

export type CliCommand =
  | { kind: 'setup'; args: string[] }
  | { kind: 'config'; args: string[] }
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
    '  config                Run the loopback browser config service',
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
  if (command === 'config') {
    return { kind: 'config', args: rest };
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

function spawnSetup(setupPath: string, args: string[], homeDir: string): Promise<number> {
  // A .ts runner (repo-dev, no dist build) needs the tsx loader; the compiled
  // .js runner runs on plain node. tsx is a devDependency, present exactly in
  // the repo-dev case where the .ts path is chosen.
  const nodeArgs = setupPath.endsWith('.ts')
    ? ['--import', 'tsx', setupPath, ...args]
    : [setupPath, ...args];
  return new Promise((resolveSpawn, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        // GARBANZO_CLI=1 tells the wizard it was spawned by the packaged CLI
        // binary (the compiled setup runner keys packaged-mode behavior off it — no
        // `npm install`, "garbanzo start" as the next-steps command).
        GARBANZO_CLI: '1',
        // The setup runner stays import-isolated from runtime config/paths,
        // so it re-derives its own output root from the raw
        // GARBANZO_HOME env var. Forward the already-resolved
        // GARBANZO_HOME_DIR so a packaged run — sentinel-driven, no explicit
        // GARBANZO_HOME set by the operator — still writes into ~/.garbanzo
        // instead of falling back to the (possibly read-only) install
        // directory. Byte-identical in repo/Docker mode, where
        // GARBANZO_HOME_DIR already equals what the runner would resolve on
        // its own.
        GARBANZO_HOME: homeDir,
      },
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

export interface SetupRunnerPaths {
  compiledPath: string;
  sourcePath: string;
  compiledExists: boolean;
  sourceExists: boolean;
  cliIsSource: boolean;
  tsxResolvable: boolean;
}

export function resolveSetupRunner(paths: SetupRunnerPaths): string {
  if (paths.compiledExists) return paths.compiledPath;
  if (paths.sourceExists && (paths.cliIsSource || paths.tsxResolvable)) return paths.sourcePath;
  throw new Error('packaged setup runner is missing — reinstall garbanzo-bot');
}

function canResolveTsx(): boolean {
  try {
    createRequire(import.meta.url).resolve('tsx');
    return true;
  } catch {
    return false;
  }
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
    const { GARBANZO_HOME_DIR } = await import('./utils/paths.js');
    // Packaged/built: this file lives in dist/, so the compiled runner sits
    // next to it. Repo-dev runs this file from src/ via tsx, where only
    // run.ts exists — fall back to the TypeScript source in that case
    // (spawnSetup detects the .ts extension and runs it through tsx).
    const compiledPath = fileURLToPath(new URL('./cli/setup/run.js', import.meta.url));
    const sourcePath = fileURLToPath(new URL('./cli/setup/run.ts', import.meta.url));
    const setupPath = resolveSetupRunner({
      compiledPath,
      sourcePath,
      compiledExists: existsSync(compiledPath),
      sourceExists: existsSync(sourcePath),
      cliIsSource: fileURLToPath(import.meta.url).endsWith('.ts'),
      tsxResolvable: canResolveTsx(),
    });
    return spawnSetup(setupPath, parsed.args, GARBANZO_HOME_DIR);
  }

  if (parsed.kind === 'config') {
    const { runConfigService } = await import('./cli/config-service/index.js');
    return runConfigService(parsed.args);
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
      skipRegistry: process.env.GARBANZO_DOCTOR_OFFLINE === '1',
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

// npm bin entries are symlinks on POSIX while Node realpaths import.meta.url,
// so the comparison must realpath argv[1] too or the installed command no-ops.
function isDirectRun(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return resolve(argv1) === fileURLToPath(import.meta.url);
  }
}

if (isDirectRun()) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((err: unknown) => {
    process.stderr.write(`garbanzo: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
