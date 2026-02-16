import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

function runNodeScript(scriptPath: string, args: string[] = []): string {
  return execFileSync('node', [scriptPath, ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
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

  it('release-checklist script shows usage with --help', () => {
    const out = runNodeScript(releaseChecklistPath, ['--help']);
    expect(out).toContain('Garbanzo release checklist helper');
    expect(out).toContain('npm run release:checklist');
  });

  it('host hardening scripts show usage with --help', () => {
    const lynisOut = runBashScript(lynisPath, ['--help']);
    const fail2banOut = runBashScript(fail2banPath, ['--help']);

    expect(lynisOut).toContain('Usage: bash scripts/host/lynis-audit.sh');
    expect(fail2banOut).toContain('Usage: bash scripts/host/fail2ban-bootstrap.sh');
  });
});
