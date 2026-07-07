import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

function runNodeScript(scriptPath: string, args: string[] = []): string {
  return execFileSync('node', [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

function runNodeScriptWithEnv(
  scriptPath: string,
  args: string[],
  envOverrides: Record<string, string>,
): string {
  return execFileSync('node', [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env, ...envOverrides },
  });
}

function runBashScript(scriptPath: string, args: string[] = []): string {
  return execFileSync('bash', [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

describe('ops scripts', () => {
  const root = process.cwd();
  const logScanPath = join(root, 'scripts/log-scan.mjs');
  const journalScanPath = join(root, 'scripts/journal-scan.sh');
  const setupPath = join(root, 'scripts/setup.mjs');
  const releaseChecklistPath = join(root, 'scripts/release-checklist.mjs');
  const releaseDeployVerifyPath = join(root, 'scripts/release-deploy-verify.sh');
  const lynisPath = join(root, 'scripts/host/lynis-audit.sh');
  const fail2banPath = join(root, 'scripts/host/fail2ban-bootstrap.sh');

  it('log-scan shows usage with --help', () => {
    const out = runNodeScript(logScanPath, ['--help']);
    expect(out).toContain('Usage: node scripts/log-scan.mjs');
  });

  it('log-scan summarizes warn/error entries from JSON logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'garbanzo-log-scan-'));
    const file = join(dir, 'app.log');

    const lines = [
      JSON.stringify({ level: 30, msg: 'info message' }),
      JSON.stringify({ level: 40, msg: 'warn message', time: 1700000000000 }),
      JSON.stringify({ level: 50, msg: 'error message' }),
      JSON.stringify({ level: 50, err: { message: 'boom' } }),
      'not-json',
    ];

    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    try {
      const out = runNodeScript(logScanPath, [file, '--min-level', 'warn', '--top', '5']);

      expect(out).toContain('Log scan results:');
      expect(out.toLowerCase()).toContain('matched level >= 40');
      expect(out.toLowerCase()).toContain('skipped: 1');
      expect(out).toContain('warn message');
      expect(out).toContain('error message');
      expect(out).toContain('err: boom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('journal-scan shows usage with --help', () => {
    const out = runBashScript(journalScanPath, ['--help']);
    expect(out).toContain('Usage: bash scripts/journal-scan.sh');
  });

  it('setup dry-run can configure Slack demo mode', () => {
    const out = runNodeScript(setupPath, [
      '--non-interactive',
      '--dry-run',
      '--platform=slack',
      '--slack-demo=true',
      '--providers=openai',
      '--openai-key=test_key_setup',
      '--owner-jid=test_owner@s.whatsapp.net',
    ]);

    expect(out).toContain('MESSAGING_PLATFORM=slack');
    expect(out).toContain('SLACK_DEMO=true');
    expect(out).toContain('Slack demo mode: true');
  });

  it('setup prints the WhatsApp account-risk caveat', () => {
    const out = runNodeScript(setupPath, [
      '--non-interactive',
      '--dry-run',
      '--platform=whatsapp',
      '--providers=openai',
      '--openai-key=test_key_setup',
      '--owner-jid=test_owner@s.whatsapp.net',
    ]);

    expect(out).toContain('unofficial WhatsApp Web API');
  });

  it('setup skips npm install and offers `garbanzo start` for a packaged (GARBANZO_CLI=1) run', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--dry-run',
        '--platform=discord',
        '--deploy=native',
        '--discord-bot-token=test_discord_token',
        '--discord-channel-id=111111111111111111',
        '--providers=openai',
        '--openai-key=test_key_setup',
      ], { GARBANZO_HOME: home, GARBANZO_CLI: '1' });

      expect(out).toContain('Packaged install detected (GARBANZO_CLI=1)');
      expect(out).toContain('garbanzo start');
      expect(out).not.toContain('npm run build && npm start');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup native Discord non-interactive run requires an enabled channel or fails clearly', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      let caught: unknown;
      try {
        runNodeScriptWithEnv(setupPath, [
          '--non-interactive',
          '--dry-run',
          '--platform=discord',
          '--deploy=native',
          '--discord-bot-token=test_discord_token',
          '--providers=openai',
          '--openai-key=test_key_setup',
        ], { GARBANZO_HOME: home });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const stdout = String((caught as { stdout?: string }).stdout ?? '');
      expect(stdout).toContain('at least one channel');
      expect(stdout).toContain('--discord-channel-id');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup native Discord non-interactive run writes the exact file set under GARBANZO_HOME with native defaults', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=discord',
        '--deploy=native',
        '--discord-bot-token=test_discord_token',
        '--discord-client-id=123456789012345678',
        '--discord-owner-id=999999999999999999',
        '--discord-channel-id=111111111111111111',
        '--discord-channel-name=general',
        '--providers=openai',
        '--openai-key=test_key_setup',
      ], { GARBANZO_HOME: home });

      expect(out).toContain('✅ Wrote .env');
      expect(out).toContain('✅ Wrote .env.discord');
      expect(out).toContain('✅ Wrote config/discord-channels.json with 1 enabled channel');

      // Exact file set under GARBANZO_HOME: .env, .env.discord, config/discord-channels.json.
      // No config/groups.json (Discord doesn't need it), no docs/PERSONA.md (no custom
      // persona given), no .git/hooks touched (pre-commit install is repo-mode only).
      const topLevel = readdirSync(home).sort();
      expect(topLevel).toEqual(['.env', '.env.discord', 'config']);
      const configFiles = readdirSync(join(home, 'config')).sort();
      expect(configFiles).toEqual(['discord-channels.json']);

      const envContent = readFileSync(join(home, '.env'), 'utf8');
      expect(envContent).not.toMatch(/^COMPOSE_PROFILES=/m);
      expect(envContent).toMatch(/^VECTOR_STORE=none$/m);

      const discordEnvContent = readFileSync(join(home, '.env.discord'), 'utf8');
      expect(discordEnvContent).toContain('DISCORD_BOT_TOKEN=test_discord_token');
      expect(discordEnvContent).toContain('DISCORD_CLIENT_ID=123456789012345678');
      expect(discordEnvContent).toContain('DISCORD_OWNER_ID=999999999999999999');

      const channelsConfig = JSON.parse(
        readFileSync(join(home, 'config', 'discord-channels.json'), 'utf8'),
      ) as { ownerId?: string; channels: Record<string, { name: string; enabled: boolean }> };
      expect(channelsConfig.ownerId).toBe('999999999999999999');
      expect(channelsConfig.channels['111111111111111111']).toEqual({
        name: 'general',
        enabled: true,
        requireMention: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('release-checklist script shows usage with --help', () => {
    const out = runNodeScript(releaseChecklistPath, ['--help']);
    expect(out).toContain('Garbanzo release checklist helper');
    expect(out).toContain('npm run release:checklist');
  });

  it('release-deploy-verify script shows usage with --help', () => {
    const out = runBashScript(releaseDeployVerifyPath, ['--help']);
    expect(out).toContain('bash scripts/release-deploy-verify.sh --version <X.Y.Z>');
    expect(out).toContain('--rollback-version <X.Y.Z>');
  });

  it('release-deploy-verify supports equals-style flags in dry-run mode', () => {
    const out = runBashScript(releaseDeployVerifyPath, [
      '--version=0.1.6',
      '--rollback-version=0.1.5',
      '--dry-run',
    ]);

    expect(out).toContain('Deploying version 0.1.6');
    expect(out).toContain('Dry run complete. No changes applied.');
  });

  it('host hardening scripts show usage with --help', () => {
    const lynisOut = runBashScript(lynisPath, ['--help']);
    const fail2banOut = runBashScript(fail2banPath, ['--help']);

    expect(lynisOut).toContain('Usage: bash scripts/host/lynis-audit.sh');
    expect(fail2banOut).toContain('Usage: bash scripts/host/fail2ban-bootstrap.sh');
  });

  it('backup scripts show usage with --help', () => {
    const backupOut = runBashScript(join(root, 'scripts/host/garbanzo-backup.sh'), ['--help']);
    const restoreOut = runBashScript(join(root, 'scripts/host/garbanzo-restore.sh'), ['--help']);

    expect(backupOut).toContain('Usage: bash scripts/host/garbanzo-backup.sh');
    expect(restoreOut).toContain('garbanzo-restore.sh');
    expect(restoreOut).toContain('--promote-snapshot');
  });

  it('backup installer renders systemd units with --dry-run', () => {
    const out = runBashScript(join(root, 'scripts/host/backup-install.sh'), ['--dry-run']);

    expect(out).toContain('garbanzo-backup.service');
    expect(out).toContain('OnCalendar=*-*-* 03:30:00');
    expect(out).toContain('Persistent=true');
    expect(out).toContain('BACKUP_DEST=/media/josh/T9/garbanzo-backups');
  });
});
