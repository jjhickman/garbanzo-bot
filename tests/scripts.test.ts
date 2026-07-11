import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
        '--discord-owner-id=999999999999999999',
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

  it('packaged Docker setup directs operators to the repository Compose stack', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--dry-run',
        '--platform=discord',
        '--deploy=docker',
        '--discord-bot-token=test_discord_token',
        '--discord-owner-id=999999999999999999',
        '--discord-channel-id=111111111111111111',
        '--providers=openai',
        '--openai-key=test_key_setup',
      ], { GARBANZO_HOME: home, GARBANZO_CLI: '1' });

      expect(out).toContain('git clone https://github.com/jjhickman/garbanzo-bot.git');
      expect(out).toContain('cd garbanzo-bot');
      expect(out).toContain('docker compose up -d');
      expect(out).toContain('repository checkout');
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
          '--discord-owner-id=999999999999999999',
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

  it('setup native Discord non-interactive run requires a bot token or fails clearly', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      let caught: unknown;
      try {
        runNodeScriptWithEnv(setupPath, [
          '--non-interactive',
          '--dry-run',
          '--platform=discord',
          '--deploy=native',
          '--discord-owner-id=999999999999999999',
          '--discord-channel-id=111111111111111111',
          '--providers=openai',
          '--openai-key=test_key_setup',
        ], { GARBANZO_HOME: home });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const stdout = String((caught as { stdout?: string }).stdout ?? '');
      expect(stdout).toContain('requires a bot token');
      expect(stdout).toContain('--discord-bot-token');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup native Discord non-interactive run requires an owner user ID or fails clearly', () => {
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
          '--discord-channel-id=111111111111111111',
          '--providers=openai',
          '--openai-key=test_key_setup',
        ], { GARBANZO_HOME: home });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const stdout = String((caught as { stdout?: string }).stdout ?? '');
      expect(stdout).toContain('requires an owner user ID');
      expect(stdout).toContain('--discord-owner-id');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup native Discord non-interactive run rejects a non-snowflake owner ID, channel ID, or client ID', () => {
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
          '--discord-owner-id=not_a_snowflake',
          '--discord-channel-id=111111111111111111',
          '--providers=openai',
          '--openai-key=test_key_setup',
        ], { GARBANZO_HOME: home });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const stdout = String((caught as { stdout?: string }).stdout ?? '');
      expect(stdout).toContain('"not_a_snowflake"');
      expect(stdout.toLowerCase()).toContain('snowflake');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup native Discord non-interactive run rejects a non-snowflake channel ID (eg a channel name)', () => {
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
          '--discord-owner-id=999999999999999999',
          '--discord-channel-id=#general',
          '--providers=openai',
          '--openai-key=test_key_setup',
        ], { GARBANZO_HOME: home });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const stdout = String((caught as { stdout?: string }).stdout ?? '');
      expect(stdout).toContain('"#general"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup native Discord non-interactive run rejects a non-snowflake client ID', () => {
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
          '--discord-owner-id=999999999999999999',
          '--discord-channel-id=111111111111111111',
          '--discord-client-id=not-an-id',
          '--providers=openai',
          '--openai-key=test_key_setup',
        ], { GARBANZO_HOME: home });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const stdout = String((caught as { stdout?: string }).stdout ?? '');
      expect(stdout).toContain('"not-an-id"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup writes docs/PERSONA.md under a fresh GARBANZO_HOME when --persona-file is given (H1)', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    const personaDir = mkdtempSync(join(tmpdir(), 'garbanzo-persona-src-'));
    const personaSource = join(personaDir, 'my-persona.md');
    writeFileSync(personaSource, '# Custom Persona\n\nBe warm and direct.\n', 'utf8');
    try {
      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=discord',
        '--deploy=native',
        '--discord-bot-token=test_discord_token',
        '--discord-owner-id=999999999999999999',
        '--discord-channel-id=111111111111111111',
        '--providers=openai',
        '--openai-key=test_key_setup',
        `--persona-file=${personaSource}`,
      ], { GARBANZO_HOME: home });

      expect(out).toContain('✅ Wrote docs/PERSONA.md');
      const personaContent = readFileSync(join(home, 'docs', 'PERSONA.md'), 'utf8');
      expect(personaContent).toContain('Be warm and direct.');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(personaDir, { recursive: true, force: true });
    }
  });

  it('setup native quickstart writes OLLAMA_BASE_URL=http://127.0.0.1:11434, not the Docker-only hostname (M2)', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=discord',
        '--deploy=native',
        '--discord-bot-token=test_discord_token',
        '--discord-owner-id=999999999999999999',
        '--discord-channel-id=111111111111111111',
        '--providers=openai',
        '--openai-key=test_key_setup',
      ], { GARBANZO_HOME: home });

      const envContent = readFileSync(join(home, '.env'), 'utf8');
      expect(envContent).toMatch(/^OLLAMA_BASE_URL=http:\/\/127\.0\.0\.1:11434$/m);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup native quickstart respects an explicit --ollama-base-url override (M2)', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=discord',
        '--deploy=native',
        '--discord-bot-token=test_discord_token',
        '--discord-owner-id=999999999999999999',
        '--discord-channel-id=111111111111111111',
        '--providers=openai',
        '--openai-key=test_key_setup',
        '--ollama-base-url=http://ollama.internal:11434',
      ], { GARBANZO_HOME: home });

      const envContent = readFileSync(join(home, '.env'), 'utf8');
      expect(envContent).toMatch(/^OLLAMA_BASE_URL=http:\/\/ollama\.internal:11434$/m);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup --discord-channel-ids dedupes duplicates in both the file and the success summary count (L1)', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=discord',
        '--deploy=native',
        '--discord-bot-token=test_discord_token',
        '--discord-owner-id=999999999999999999',
        '--discord-channel-ids=111111111111111111,111111111111111111,222222222222222222',
        '--providers=openai',
        '--openai-key=test_key_setup',
      ], { GARBANZO_HOME: home });

      expect(out).toContain('✅ Wrote config/discord-channels.json with 2 enabled channels');

      const channelsConfig = JSON.parse(
        readFileSync(join(home, 'config', 'discord-channels.json'), 'utf8'),
      ) as { channels: Record<string, unknown> };
      expect(Object.keys(channelsConfig.channels).sort()).toEqual([
        '111111111111111111',
        '222222222222222222',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup fails non-interactively when an existing discord-channels.json has zero enabled channels and no new channel is given (M1a)', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const configDir = join(home, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'discord-channels.json'),
        JSON.stringify({
          channels: {
            '333333333333333333': { name: 'archived', enabled: false, requireMention: true },
          },
        }),
        'utf8',
      );

      let caught: unknown;
      try {
        runNodeScriptWithEnv(setupPath, [
          '--non-interactive',
          '--dry-run',
          '--platform=discord',
          '--deploy=native',
          '--discord-bot-token=test_discord_token',
          '--discord-owner-id=999999999999999999',
          '--providers=openai',
          '--openai-key=test_key_setup',
        ], { GARBANZO_HOME: home });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const stdout = String((caught as { stdout?: string }).stdout ?? '');
      expect(stdout).toContain('at least one channel');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup merges an explicit --discord-channel-id into an existing discord-channels.json, preserving prior entries and backing up the original (M1b)', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const configDir = join(home, 'config');
      mkdirSync(configDir, { recursive: true });
      const originalConfig = {
        ownerId: '888888888888888888',
        operatorNote: 'keep this top-level setting',
        channels: {
          '333333333333333333': { name: 'general', enabled: true, requireMention: true },
        },
      };
      writeFileSync(join(configDir, 'discord-channels.json'), JSON.stringify(originalConfig), 'utf8');

      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=discord',
        '--deploy=native',
        '--discord-bot-token=test_discord_token',
        '--discord-owner-id=999999999999999999',
        '--discord-channel-id=444444444444444444',
        '--discord-channel-name=events',
        '--providers=openai',
        '--openai-key=test_key_setup',
      ], { GARBANZO_HOME: home });

      expect(out).toContain('✅ Wrote config/discord-channels.json with 2 enabled channels');
      expect(out).toContain('Existing config/discord-channels.json backed up');

      const backupConfig = JSON.parse(
        readFileSync(join(configDir, 'discord-channels.json.bak'), 'utf8'),
      );
      expect(backupConfig).toEqual(originalConfig);

      const channelsConfig = JSON.parse(
        readFileSync(join(configDir, 'discord-channels.json'), 'utf8'),
      ) as { ownerId?: string; operatorNote?: string; channels: Record<string, { name: string; enabled: boolean }> };
      // Original entry preserved...
      expect(channelsConfig.channels['333333333333333333']).toEqual({
        name: 'general',
        enabled: true,
        requireMention: true,
      });
      // ...and the new one merged in.
      expect(channelsConfig.channels['444444444444444444']).toEqual({
        name: 'events',
        enabled: true,
        requireMention: true,
      });
      // Pre-existing ownerId in the file is preserved over the run's --discord-owner-id.
      expect(channelsConfig.ownerId).toBe('888888888888888888');
      expect(channelsConfig.operatorNote).toBe('keep this top-level setting');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup rerun preserves unrelated operator keys in existing env files', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      writeFileSync(
        join(home, '.env'),
        [
          '# existing operator note',
          'MESSAGING_PLATFORM=whatsapp',
          'OPENAI_MODEL=old-model',
          'OPERATOR_ONLY=keep-me',
          '',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        join(home, '.env.whatsapp'),
        [
          '# platform operator note',
          'OWNER_JID=old_owner@s.whatsapp.net',
          'WHATSAPP_EXTRA=keep-platform',
          '',
        ].join('\n'),
        'utf8',
      );

      runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=whatsapp',
        '--write-groups=false',
        '--providers=openai',
        '--openai-key=test_key_setup',
        '--openai-model=gpt-updated',
        '--owner-jid=test_owner@s.whatsapp.net',
      ], { GARBANZO_HOME: home });

      const envContent = readFileSync(join(home, '.env'), 'utf8');
      expect(envContent).toContain('# existing operator note');
      expect(envContent).toMatch(/^OPERATOR_ONLY=keep-me$/m);
      expect(envContent).toMatch(/^OPENAI_MODEL=gpt-updated$/m);

      const whatsappEnvContent = readFileSync(join(home, '.env.whatsapp'), 'utf8');
      expect(whatsappEnvContent).toContain('# platform operator note');
      expect(whatsappEnvContent).toMatch(/^WHATSAPP_EXTRA=keep-platform$/m);
      expect(whatsappEnvContent).toMatch(/^OWNER_JID=test_owner@s\.whatsapp\.net$/m);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup dry-run env preview preserves but redacts unknown operator keys', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      writeFileSync(
        join(home, '.env'),
        [
          'MESSAGING_PLATFORM=whatsapp',
          'OPERATOR_ONLY=keep-me',
          '',
        ].join('\n'),
        'utf8',
      );

      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--dry-run',
        '--platform=whatsapp',
        '--write-groups=false',
        '--providers=openai',
        '--openai-key=test_key_setup',
        '--owner-jid=test_owner@s.whatsapp.net',
      ], { GARBANZO_HOME: home });

      expect(out).toContain('--- .env (preview) ---');
      expect(out).toContain('OPERATOR_ONLY=[REDACTED]');
      expect(out).not.toContain('OPERATOR_ONLY=keep-me');
      expect(readFileSync(join(home, '.env'), 'utf8')).toContain('OPERATOR_ONLY=keep-me');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup rerun merges config/groups.json and preserves unrelated groups and admin settings', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const configDir = join(home, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'groups.json'),
        JSON.stringify({
          groups: {
            '999000000000000000@g.us': {
              name: 'Unrelated',
              enabled: true,
              requireMention: false,
              persona: 'Keep me',
              enabledFeatures: ['help'],
            },
          },
          mentionPatterns: ['@oldbot'],
          admins: {
            owner: { name: 'Old Owner', jid: 'old_owner@s.whatsapp.net' },
            moderators: ['moderator@s.whatsapp.net'],
          },
          operatorNote: 'keep this groups setting',
        }),
        'utf8',
      );

      runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=whatsapp',
        '--group-id=120000000000000000@g.us',
        '--group-name=General',
        '--bot-name=garbanzo',
        '--owner-name=Owner',
        '--write-groups=true',
        '--providers=openai',
        '--openai-key=test_key_setup',
        '--owner-jid=test_owner@s.whatsapp.net',
      ], { GARBANZO_HOME: home });

      const groupsConfig = JSON.parse(
        readFileSync(join(configDir, 'groups.json'), 'utf8'),
      ) as {
        groups: Record<string, unknown>;
        admins: { moderators: string[] };
        mentionPatterns: string[];
        operatorNote?: string;
      };
      expect(groupsConfig.groups['999000000000000000@g.us']).toEqual({
        name: 'Unrelated',
        enabled: true,
        requireMention: false,
        persona: 'Keep me',
        enabledFeatures: ['help'],
      });
      expect(groupsConfig.groups['120000000000000000@g.us']).toEqual({
        name: 'General',
        enabled: true,
        requireMention: true,
        persona: 'Friendly community assistant. Help with logistics, planning, and conversation.',
        enabledFeatures: ['weather', 'transit', 'news', 'events', 'dnd', 'roll', 'books', 'venues', 'poll', 'fun', 'character', 'feedback', 'profile', 'summary', 'recommend', 'voice'],
      });
      expect(groupsConfig.admins.moderators).toEqual(['moderator@s.whatsapp.net']);
      expect(groupsConfig.mentionPatterns).toEqual(['@garbanzo', '@Garbanzo', '@bot']);
      expect(groupsConfig.operatorNote).toBe('keep this groups setting');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup interactive mode aborts with a nonzero exit when stdin hits EOF mid-flow (M3)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const result = await new Promise<{ code: number | null; stderr: string }>((resolvePromise, reject) => {
        const child = spawn('node', [setupPath], {
          cwd: process.cwd(),
          env: { ...process.env, GARBANZO_HOME: home },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => resolvePromise({ code, stderr }));

        // Close stdin immediately — simulates a closed terminal / empty pipe
        // while the wizard is still awaiting interactive input.
        child.stdin.end();
      });

      expect(result.code).not.toBe(0);
      expect(result.code).not.toBeNull();
      expect(result.stderr).toContain('Setup aborted before completion');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);

  it('setup --help documents --discord-channel-ids, --discord-channel-name, --vector-store, and --install-deps (L2)', () => {
    const out = runNodeScript(setupPath, ['--help']);
    expect(out).toContain('--discord-channel-ids');
    expect(out).toContain('--discord-channel-name');
    expect(out).toContain('--vector-store');
    expect(out).toContain('--install-deps');
  });

  it('setup --help documents --telegram-chat-ids and --telegram-chat-name', () => {
    const out = runNodeScript(setupPath, ['--help']);
    expect(out).toContain('--telegram-chat-ids');
    expect(out).toContain('--telegram-chat-name');
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

  it('setup native Telegram non-interactive run writes the exact file set under GARBANZO_HOME with native defaults', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=telegram',
        '--deploy=native',
        '--telegram-bot-token=test_telegram_token',
        '--telegram-owner-id=123456789',
        '--telegram-chat-id=-1001234567890',
        '--telegram-chat-name=general',
        '--providers=openai',
        '--openai-key=test_key_setup',
      ], { GARBANZO_HOME: home });

      expect(out).toContain('✅ Wrote .env');
      expect(out).toContain('✅ Wrote .env.telegram');
      expect(out).toContain('✅ Wrote config/telegram-chats.json with 1 enabled chat');

      // Exact file set under GARBANZO_HOME: .env, .env.telegram, config/telegram-chats.json.
      // No config/groups.json (Telegram doesn't need it), no docs/PERSONA.md (no custom
      // persona given), no .git/hooks touched (pre-commit install is repo-mode only).
      const topLevel = readdirSync(home).sort();
      expect(topLevel).toEqual(['.env', '.env.telegram', 'config']);
      const configFiles = readdirSync(join(home, 'config')).sort();
      expect(configFiles).toEqual(['telegram-chats.json']);

      const envContent = readFileSync(join(home, '.env'), 'utf8');
      expect(envContent).not.toMatch(/^COMPOSE_PROFILES=/m);
      expect(envContent).toMatch(/^VECTOR_STORE=none$/m);

      const telegramEnvContent = readFileSync(join(home, '.env.telegram'), 'utf8');
      expect(telegramEnvContent).toContain('TELEGRAM_BOT_TOKEN=test_telegram_token');
      expect(telegramEnvContent).toContain('TELEGRAM_OWNER_ID=123456789');
      expect(telegramEnvContent).toContain('TELEGRAM_CHAT_SCOPE=configured');

      const chatsConfig = JSON.parse(
        readFileSync(join(home, 'config', 'telegram-chats.json'), 'utf8'),
      ) as { ownerId?: string; chats: Record<string, { name: string; enabled: boolean }> };
      expect(chatsConfig.ownerId).toBe('123456789');
      expect(chatsConfig.chats['-1001234567890']).toEqual({
        name: 'general',
        enabled: true,
        requireMention: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup Docker Telegram non-interactive run pins COMPOSE_PROFILES=telegram and writes the platform-keyed env file', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=telegram',
        '--telegram-bot-token=test_telegram_token',
        '--telegram-owner-id=123456789',
        '--telegram-chat-id=-1001234567890',
        '--providers=openai',
        '--openai-key=test_key_setup',
      ], { GARBANZO_HOME: home });

      expect(out).toContain('✅ Wrote .env');
      expect(out).toContain('✅ Wrote .env.telegram');

      const envContent = readFileSync(join(home, '.env'), 'utf8');
      expect(envContent).toMatch(/^COMPOSE_PROFILES=telegram$/m);
      expect(envContent).not.toMatch(/^VECTOR_STORE=/m);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup Telegram non-interactive run accepts valid chat id shapes', () => {
    const validIds = [
      '123456789',
      '-123456789',
      '-1001234567890',
    ];

    for (const chatId of validIds) {
      const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
      try {
        const out = runNodeScriptWithEnv(setupPath, [
          '--non-interactive',
          '--dry-run',
          '--platform=telegram',
          '--telegram-bot-token=test_telegram_token',
          '--telegram-owner-id=123456789',
          `--telegram-chat-id=${chatId}`,
          '--providers=openai',
          '--openai-key=test_key_setup',
        ], { GARBANZO_HOME: home });

        expect(out).toContain(chatId);
        expect(out).toContain('config/telegram-chats.json');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('setup Telegram non-interactive run rejects invalid chat id shapes with the value named', () => {
    const invalidIds = [
      '0',
      '-100',
      '123456789012345678901234567890',
      'not-a-chat-id',
      '012345',
    ];

    for (const chatId of invalidIds) {
      const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
      try {
        let caught: unknown;
        try {
          runNodeScriptWithEnv(setupPath, [
            '--non-interactive',
            '--dry-run',
            '--platform=telegram',
            '--telegram-bot-token=test_telegram_token',
            '--telegram-owner-id=123456789',
            `--telegram-chat-id=${chatId}`,
            '--providers=openai',
            '--openai-key=test_key_setup',
          ], { GARBANZO_HOME: home });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeDefined();
        const stdout = String((caught as { stdout?: string }).stdout ?? '');
        expect(stdout).toContain(`"${chatId}"`);
        expect(stdout).toMatch(/doesn't look like a Telegram chat ID/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it('setup Telegram non-interactive run requires a bot token, owner ID, and enabled chat or fails clearly', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));

    function expectSetupFailure(args: string[], expected: RegExp): void {
      let caught: unknown;
      try {
        runNodeScriptWithEnv(setupPath, ['--non-interactive', '--dry-run', ...args], { GARBANZO_HOME: home });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const stdout = String((caught as { stdout?: string }).stdout ?? '');
      expect(stdout).toMatch(expected);
    }

    try {
      expectSetupFailure(
        [
          '--platform=telegram',
          '--telegram-owner-id=123456789',
          '--telegram-chat-id=-1001234567890',
          '--providers=openai',
          '--openai-key=test_key_setup',
        ],
        /Telegram quickstart requires a bot token/,
      );

      expectSetupFailure(
        [
          '--platform=telegram',
          '--telegram-bot-token=test_telegram_token',
          '--telegram-chat-id=-1001234567890',
          '--providers=openai',
          '--openai-key=test_key_setup',
        ],
        /Telegram quickstart requires an owner user ID/,
      );

      expectSetupFailure(
        [
          '--platform=telegram',
          '--telegram-bot-token=test_telegram_token',
          '--telegram-owner-id=123456789',
          '--providers=openai',
          '--openai-key=test_key_setup',
        ],
        /Telegram quickstart requires at least one chat to enable/,
      );

      expectSetupFailure(
        [
          '--platform=telegram',
          '--telegram-bot-token=test_telegram_token',
          '--telegram-owner-id=not-numeric',
          '--telegram-chat-id=-1001234567890',
          '--providers=openai',
          '--openai-key=test_key_setup',
        ],
        /doesn't look like a Telegram user id/,
      );

      expectSetupFailure(
        [
          '--platform=telegram',
          '--telegram-bot-token=test_telegram_token',
          '--telegram-owner-id=123456789',
          '--telegram-chat-id=not-a-chat-id',
          '--providers=openai',
          '--openai-key=test_key_setup',
        ],
        /doesn't look like a Telegram chat ID/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup native Matrix non-interactive run writes the exact file set under GARBANZO_HOME with native defaults', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=matrix',
        '--deploy=native',
        '--matrix-homeserver-url=https://matrix.example.org',
        '--matrix-access-token=test_matrix_token',
        '--matrix-owner-id=@owner:example.org',
        '--matrix-room-id=!abcdefgh:example.org',
        '--matrix-room-name=general',
        '--providers=openai',
        '--openai-key=test_key_setup',
      ], { GARBANZO_HOME: home });

      expect(out).toContain('✅ Wrote .env');
      expect(out).toContain('✅ Wrote .env.matrix');
      expect(out).toContain('✅ Wrote config/matrix-rooms.json with 1 enabled room');

      const topLevel = readdirSync(home).sort();
      expect(topLevel).toEqual(['.env', '.env.matrix', 'config']);
      const configFiles = readdirSync(join(home, 'config')).sort();
      expect(configFiles).toEqual(['matrix-rooms.json']);

      const envContent = readFileSync(join(home, '.env'), 'utf8');
      expect(envContent).not.toMatch(/^COMPOSE_PROFILES=/m);
      expect(envContent).toMatch(/^VECTOR_STORE=none$/m);

      const matrixEnvContent = readFileSync(join(home, '.env.matrix'), 'utf8');
      expect(matrixEnvContent).toContain('MATRIX_HOMESERVER_URL=https://matrix.example.org');
      expect(matrixEnvContent).toContain('MATRIX_ACCESS_TOKEN=test_matrix_token');
      expect(matrixEnvContent).toContain('MATRIX_OWNER_ID=@owner:example.org');
      expect(matrixEnvContent).toContain('MATRIX_CHAT_SCOPE=configured');

      const roomsConfig = JSON.parse(
        readFileSync(join(home, 'config', 'matrix-rooms.json'), 'utf8'),
      ) as { ownerId?: string; rooms: Record<string, { name: string; enabled: boolean }> };
      expect(roomsConfig.ownerId).toBe('@owner:example.org');
      expect(roomsConfig.rooms['!abcdefgh:example.org']).toEqual({
        name: 'general',
        enabled: true,
        requireMention: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup Docker Matrix non-interactive run pins COMPOSE_PROFILES=matrix', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=matrix',
        '--matrix-homeserver-url=https://matrix.example.org',
        '--matrix-access-token=test_matrix_token',
        '--matrix-owner-id=@owner:example.org',
        '--matrix-room-id=!abcdefgh:example.org',
        '--providers=openai',
        '--openai-key=test_key_setup',
      ], { GARBANZO_HOME: home });

      expect(out).toContain('✅ Wrote .env.matrix');
      const envContent = readFileSync(join(home, '.env'), 'utf8');
      expect(envContent).toMatch(/^COMPOSE_PROFILES=matrix$/m);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup Matrix non-interactive run fails clearly on missing or malformed inputs', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));

    function expectSetupFailure(args: string[], expected: RegExp): void {
      let caught: unknown;
      try {
        runNodeScriptWithEnv(setupPath, ['--non-interactive', '--dry-run', ...args], { GARBANZO_HOME: home });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const stdout = String((caught as { stdout?: string }).stdout ?? '');
      expect(stdout).toMatch(expected);
    }

    const base = [
      '--platform=matrix',
      '--providers=openai',
      '--openai-key=test_key_setup',
    ];

    try {
      expectSetupFailure(
        [...base, '--matrix-access-token=t', '--matrix-owner-id=@o:x.org', '--matrix-room-id=!r:x.org'],
        /Matrix quickstart requires a homeserver URL/,
      );
      expectSetupFailure(
        [...base, '--matrix-homeserver-url=matrix.example.org', '--matrix-access-token=t', '--matrix-owner-id=@o:x.org', '--matrix-room-id=!r:x.org'],
        /--matrix-homeserver-url .* doesn't look like a homeserver URL/,
      );
      expectSetupFailure(
        [...base, '--matrix-homeserver-url=https://x.org', '--matrix-owner-id=@o:x.org', '--matrix-room-id=!r:x.org'],
        /Matrix quickstart requires a bot access token/,
      );
      expectSetupFailure(
        [...base, '--matrix-homeserver-url=https://x.org', '--matrix-access-token=t', '--matrix-room-id=!r:x.org'],
        /Matrix quickstart requires an owner user id/,
      );
      expectSetupFailure(
        [...base, '--matrix-homeserver-url=https://x.org', '--matrix-access-token=t', '--matrix-owner-id=not-an-mxid', '--matrix-room-id=!r:x.org'],
        /doesn't look like a Matrix user id/,
      );
      expectSetupFailure(
        [...base, '--matrix-homeserver-url=https://x.org', '--matrix-access-token=t', '--matrix-owner-id=@o:x.org'],
        /Matrix quickstart requires at least one room to enable/,
      );
      expectSetupFailure(
        [...base, '--matrix-homeserver-url=https://x.org', '--matrix-access-token=t', '--matrix-owner-id=@o:x.org', '--matrix-room-id=not-a-room'],
        /neither a room id nor an alias/,
      );
      // Aliases need a live homeserver; dry-run must refuse rather than fetch.
      expectSetupFailure(
        [...base, '--matrix-homeserver-url=https://x.org', '--matrix-access-token=t', '--matrix-owner-id=@o:x.org', '--matrix-room-id=#alias:x.org'],
        /Dry-run cannot resolve the alias/,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    // 7 sequential wizard spawns; the compat wrapper boots tsx per spawn in
    // repo-dev (~1-2s each), so the default 5s timeout is far too tight.
  }, 60000);

  it('setup writes docs/personas/discord.md under GARBANZO_HOME when --persona=quill is given (WS10)', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=discord',
        '--deploy=native',
        '--discord-bot-token=test_discord_token',
        '--discord-owner-id=999999999999999999',
        '--discord-channel-id=111111111111111111',
        '--providers=openai',
        '--openai-key=test_key_setup',
        '--persona=quill',
      ], { GARBANZO_HOME: home });

      expect(out).toContain('✅ Wrote docs/personas/discord.md');
      // docs/PERSONA.md must NOT be written — the platform-keyed slot is the
      // review-mandated destination (a shipped discord.md shadows PERSONA.md).
      const topLevel = readdirSync(home).sort();
      expect(topLevel).toEqual(['.env', '.env.discord', 'config', 'docs']);
      const personaContent = readFileSync(join(home, 'docs', 'personas', 'discord.md'), 'utf8');
      expect(personaContent).toContain('Quill');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup writes docs/personas/matrix.md when --persona=bea and --platform=matrix are given (WS10)', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const out = runNodeScriptWithEnv(setupPath, [
        '--non-interactive',
        '--platform=matrix',
        '--deploy=native',
        '--matrix-homeserver-url=https://matrix.example.org',
        '--matrix-access-token=test_matrix_token',
        '--matrix-owner-id=@owner:example.org',
        '--matrix-room-id=!abcdefgh:example.org',
        '--providers=openai',
        '--openai-key=test_key_setup',
        '--persona=bea',
      ], { GARBANZO_HOME: home });

      expect(out).toContain('✅ Wrote docs/personas/matrix.md');
      const personaContent = readFileSync(join(home, 'docs', 'personas', 'matrix.md'), 'utf8');
      expect(personaContent).toContain('Bea');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup backs up an existing platform persona file to .bak when --persona overwrites it (WS10)', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const args = [
        '--non-interactive',
        '--platform=discord',
        '--deploy=native',
        '--discord-bot-token=test_discord_token',
        '--discord-owner-id=999999999999999999',
        '--discord-channel-id=111111111111111111',
        '--providers=openai',
        '--openai-key=test_key_setup',
      ];
      runNodeScriptWithEnv(setupPath, [...args, '--persona=quill'], { GARBANZO_HOME: home });
      const out = runNodeScriptWithEnv(setupPath, [...args, '--persona=margie'], { GARBANZO_HOME: home });

      expect(out).toContain('backed up to docs/personas/discord.md.bak');
      const backupContent = readFileSync(join(home, 'docs', 'personas', 'discord.md.bak'), 'utf8');
      expect(backupContent).toContain('Quill');
      const currentContent = readFileSync(join(home, 'docs', 'personas', 'discord.md'), 'utf8');
      expect(currentContent).toContain('Margie');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup --persona with an unknown gallery name fails and lists the available names (WS10)', () => {
    let caught: unknown;
    try {
      runNodeScript(setupPath, [
        '--non-interactive',
        '--dry-run',
        '--platform=discord',
        '--deploy=native',
        '--discord-bot-token=test_discord_token',
        '--discord-owner-id=999999999999999999',
        '--discord-channel-id=111111111111111111',
        '--providers=openai',
        '--openai-key=test_key_setup',
        '--persona=not-a-real-persona',
      ]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const stdout = String((caught as { stdout?: string }).stdout ?? '');
    expect(stdout).toContain('Unknown persona "not-a-real-persona"');
    expect(stdout).toContain('riff, quill, margie, bea, patch, callie');
  });

  it('setup --persona=riff on Discord notes the BAND_FEATURES_ENABLED pairing unless already enabled (WS10)', () => {
    const home = mkdtempSync(join(tmpdir(), 'garbanzo-setup-home-'));
    try {
      const args = [
        '--non-interactive',
        '--platform=discord',
        '--deploy=native',
        '--discord-bot-token=test_discord_token',
        '--discord-owner-id=999999999999999999',
        '--discord-channel-id=111111111111111111',
        '--providers=openai',
        '--openai-key=test_key_setup',
        '--persona=riff',
      ];
      const withoutBand = runNodeScriptWithEnv(setupPath, args, { GARBANZO_HOME: home });
      expect(withoutBand).toContain('pairs with the band feature set');
      expect(withoutBand).toContain('--band-features-enabled=true');

      const withBand = runNodeScriptWithEnv(
        setupPath,
        [...args, '--band-features-enabled=true'],
        { GARBANZO_HOME: home },
      );
      expect(withBand).not.toContain('pairs with the band feature set');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('setup --help documents the --persona gallery picker flag (WS10)', () => {
    const out = runNodeScript(setupPath, ['--help']);
    expect(out).toContain('--persona ');
    expect(out).toContain('riff, quill, margie, bea, patch, callie');
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
