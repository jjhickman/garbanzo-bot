import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { parseCliCommand, resolveSetupRunner, runCli } from '../src/cli.js';
import {
  collectDoctorReport,
  formatDoctorReport,
  parseLayeredEnv,
  satisfiesEngine,
} from '../src/cli/doctor.js';
import {
  isEphemeralNpxRoot,
  renderLaunchdPlist,
  renderSystemdUnit,
} from '../src/cli/service-install.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'garbanzo-cli-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCliSubprocess(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: resolve('.'),
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => resolveResult({ code }));
  });
}

// Minimal explicit env, NOT a scrubbed copy of process.env: inheriting the
// parent env leaves holes (e.g. OPENAI_AUTH_MODE=oauth satisfies runtime
// config validation with no key set) that would make the isolation proof
// vacuous on a developer machine.
function cleanCliEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GARBANZO_HOME: home,
    GARBANZO_DOCTOR_OFFLINE: '1',
  };
}

describe('CLI routing', () => {
  it('routes setup/start/doctor/service/help/version without importing runtime config', () => {
    expect(parseCliCommand(['setup'])).toEqual({ kind: 'setup', args: [] });
    expect(parseCliCommand(['start'])).toEqual({ kind: 'start' });
    expect(parseCliCommand(['doctor'])).toEqual({ kind: 'doctor' });
    expect(parseCliCommand(['service', 'install'])).toEqual({ kind: 'service', action: 'install', force: false, system: false });
    expect(parseCliCommand(['service', 'uninstall', '--system'])).toEqual({ kind: 'service', action: 'uninstall', force: false, system: true });
    expect(parseCliCommand(['--help'])).toEqual({ kind: 'help', exitCode: 0 });
    expect(parseCliCommand(['--version'])).toEqual({ kind: 'version' });
  });

  it('routes unknown commands to help with exit 1', () => {
    expect(parseCliCommand(['wat'])).toEqual({ kind: 'help', exitCode: 1, error: "Unknown command: wat" });
    expect(parseCliCommand(['service'])).toEqual({ kind: 'help', exitCode: 1, error: 'Usage: garbanzo service install|uninstall' });
  });

  it('prints help for unknown commands and returns exit 1', async () => {
    let stdout = '';
    let stderr = '';
    const code = await runCli(['nope'], {
      stdout: (message) => { stdout += message; },
      stderr: (message) => { stderr += message; },
    });

    expect(code).toBe(1);
    expect(stderr).toContain('Unknown command: nope');
    expect(stdout).toContain('Usage: garbanzo');
  });

  it('reports a damaged packaged runner instead of falling through to TypeScript', () => {
    expect(() => resolveSetupRunner({
      compiledPath: '/package/dist/cli/setup/run.js',
      sourcePath: '/package/dist/cli/setup/run.ts',
      compiledExists: false,
      sourceExists: false,
      cliIsSource: false,
      tsxResolvable: false,
    })).toThrow('packaged setup runner is missing — reinstall garbanzo-bot');
  });

  it('uses the TypeScript runner only for a resolvable repo-development path', () => {
    expect(resolveSetupRunner({
      compiledPath: '/repo/src/cli/setup/run.js',
      sourcePath: '/repo/src/cli/setup/run.ts',
      compiledExists: false,
      sourceExists: true,
      cliIsSource: true,
      tsxResolvable: true,
    })).toBe('/repo/src/cli/setup/run.ts');
  });
});

describe('CLI import isolation', () => {
  it('prints help in a clean home with no app env vars', async () => {
    await withTempDir(async (home) => {
      const result = await runCliSubprocess(['--help'], cleanCliEnv(home));

      expect(result.code).toBe(0);
    });
  });

  it('runs doctor in a clean home with no app env vars', async () => {
    await withTempDir(async (home) => {
      const result = await runCliSubprocess(['doctor'], cleanCliEnv(home));

      expect(result.code).toBe(0);
    });
  });

  it('prints setup help in a clean home without importing runtime config', async () => {
    await withTempDir(async (home) => {
      const result = await runCliSubprocess(['setup', '--help'], cleanCliEnv(home));

      expect(result.code).toBe(0);
    });
  });

  it('executes when invoked through a symlink, as npm bin shims are on POSIX', async () => {
    await withTempDir(async (home) => {
      const linkPath = join(home, 'garbanzo');
      await symlink(resolve('src/cli.ts'), linkPath);

      const unknown = await new Promise<{ code: number | null }>((resolveResult, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', linkPath, 'definitely-not-a-command'], {
          cwd: resolve('.'),
          env: cleanCliEnv(home),
          stdio: 'ignore',
        });
        child.on('error', reject);
        child.on('close', (code) => resolveResult({ code }));
      });

      // A silent no-op would exit 0 here; real execution must exit 1.
      expect(unknown.code).toBe(1);
    });
  });
});

describe('doctor report', () => {
  it('reads provider booleans from process env plus layered env files without schema imports', async () => {
    await withTempDir(async (home) => {
      await writeFile(join(home, '.env'), 'MESSAGING_PLATFORM=discord\nOPENROUTER_API_KEY=file_key\nHEALTH_PORT=0\n');
      await writeFile(join(home, '.env.discord'), 'OPENAI_API_KEY=platform_key\n');

      const layered = parseLayeredEnv(home, { GEMINI_API_KEY: 'real_key' });

      expect(layered.env.OPENROUTER_API_KEY).toBe('file_key');
      expect(layered.env.OPENAI_API_KEY).toBe('platform_key');
      expect(layered.env.GEMINI_API_KEY).toBe('real_key');
      expect(layered.loadedFiles.map((file) => file.replace(`${home}/`, ''))).toEqual(['.env', '.env.discord']);
    });
  });

  it('formats machine-parseable sections', async () => {
    await withTempDir(async (home) => {
      const report = await collectDoctorReport({
        packageRoot: resolve('.'),
        homeDir: home,
        mode: 'env-set',
        env: { HEALTH_PORT: '0', PIPER_BIN: join(home, 'missing-piper') },
        skipRegistry: true,
      });

      const text = formatDoctorReport(report);

      for (const section of ['[node]', '[paths]', '[config-files]', '[binaries]', '[providers]', '[health-port]', '[version]']) {
        expect(text).toContain(section);
      }
      expect(text).toContain('mode=env-set');
      expect(text).toContain('home=');
      expect(text).toContain('openrouter=false');
      expect(text).toContain('latest=skipped');
    });
  });

  it('detects Node versions below the package engine requirement', () => {
    expect(satisfiesEngine('v20.1.0', '>=20.0.0')).toBe(true);
    expect(satisfiesEngine('v19.9.0', '>=20.0.0')).toBe(false);
  });
});

describe('service install rendering', () => {
  it('renders a systemd unit with node path, GARBANZO_HOME, working directory, and cli entrypoint', () => {
    const unit = renderSystemdUnit({
      template: [
        '[Unit]',
        'Description=Garbanzo WhatsApp Bot',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        'WorkingDirectory=/old',
        'ExecStart=/old/node dist/index.js',
        'Restart=on-failure',
        'RestartSec=10',
        'Environment=NODE_ENV=production',
        '',
        '[Install]',
        'WantedBy=default.target',
      ].join('\n'),
      nodePath: '/usr/bin/node',
      packageRoot: '/opt/garbanzo',
      homeDir: '/home/operator/.garbanzo',
      entryPath: '/opt/garbanzo/dist/cli.js',
      entryArgs: ['start'],
    });

    expect(unit).toContain('WorkingDirectory=/opt/garbanzo');
    expect(unit).toContain('ExecStart=/usr/bin/node /opt/garbanzo/dist/cli.js start');
    expect(unit).toContain('Environment=NODE_ENV=production');
    expect(unit).toContain('Environment=GARBANZO_HOME=/home/operator/.garbanzo');
  });

  it('renders a launchd plist with node path, GARBANZO_HOME, working directory, and cli entrypoint', () => {
    const plist = renderLaunchdPlist({
      nodePath: '/usr/local/bin/node',
      packageRoot: '/opt/garbanzo',
      homeDir: '/Users/operator/.garbanzo',
      entryPath: '/opt/garbanzo/dist/cli.js',
      entryArgs: ['start'],
    });

    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>/opt/garbanzo/dist/cli.js</string>');
    expect(plist).toContain('<string>start</string>');
    expect(plist).toContain('<key>GARBANZO_HOME</key>');
    expect(plist).toContain('<string>/Users/operator/.garbanzo</string>');
    expect(plist).toContain('<key>WorkingDirectory</key>');
    expect(plist).toContain('<string>/opt/garbanzo</string>');
  });

  it('detects ephemeral npx cache roots', () => {
    expect(isEphemeralNpxRoot('/home/operator/.npm/_npx/abc/node_modules/garbanzo-bot')).toBe(true);
    expect(isEphemeralNpxRoot('/home/operator/.npm/_cacache/tmp/garbanzo-bot')).toBe(true);
    expect(isEphemeralNpxRoot('C:\\Users\\op\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\garbanzo-bot')).toBe(true);
    expect(isEphemeralNpxRoot('/home/op/.cache/pnpm/dlx-91ab2c/node_modules/garbanzo-bot')).toBe(true);
    expect(isEphemeralNpxRoot('/tmp/xfs-0a1b2c3d/dlx/node_modules/garbanzo-bot')).toBe(true);
    expect(isEphemeralNpxRoot('/usr/local/lib/node_modules/garbanzo-bot')).toBe(false);
    // Segment matching: names merely containing the keywords are not caches
    expect(isEphemeralNpxRoot('/home/op/projects/db_cacache_tools/node_modules/garbanzo-bot')).toBe(false);
  });

  it('escapes literal % for systemd specifier expansion', () => {
    const unit = renderSystemdUnit({
      template: ['[Unit]', '[Service]', 'Environment=NODE_ENV=production', '[Install]'].join('\n'),
      nodePath: '/usr/bin/node',
      packageRoot: '/srv/my%20apps/garbanzo',
      homeDir: '/home/op/.garbanzo',
      entryPath: '/srv/my%20apps/garbanzo/dist/cli.js',
      entryArgs: ['start'],
    });

    expect(unit).toContain('WorkingDirectory=/srv/my%%20apps/garbanzo');
    // No lone % (unescaped specifier) may survive anywhere in the unit
    expect(unit).not.toMatch(/(?<!%)%(?!%)/);
  });

  it('errors loudly instead of writing a unit from a missing template', async () => {
    await withTempDir(async (home) => {
      const { runServiceCommand } = await import('../src/cli/service-install.js');
      let stderr = '';
      const code = await runServiceCommand({
        action: 'install',
        force: false,
        system: false,
        packageRoot: home,
        homeDir: home,
        templatePath: join(home, 'missing', 'garbanzo.service'),
        platform: 'linux',
      }, {
        stdout: () => {},
        stderr: (message) => { stderr += message; },
      });

      expect(code).toBe(1);
      expect(stderr).toContain('Service template not found');
    });
  });
});

describe('setup backup ignores', () => {
  it('ignores setup .bak artifacts', async () => {
    const gitignore = await readFile('.gitignore', 'utf8');

    expect(gitignore).toContain('.env.bak');
    expect(gitignore).toContain('.env.*.bak');
    expect(gitignore).toContain('config/*.json.bak');
    expect(gitignore).toContain('docs/PERSONA.md.bak');
  });
});
