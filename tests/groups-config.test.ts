import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const logger = {
  warn: vi.fn(),
  error: vi.fn(),
};

function tempProjectRoot(): string {
  return mkdtempSync(join(tmpdir(), 'garbanzo-groups-config-'));
}

async function loadGroupsConfig(projectRoot: string) {
  vi.resetModules();
  logger.warn.mockClear();
  logger.error.mockClear();
  vi.doMock('../src/utils/paths.js', () => ({
    homePath: (...segments: string[]) => join(projectRoot, ...segments),
    assetPath: (...segments: string[]) => join(projectRoot, ...segments),
  }));
  vi.doMock('../src/middleware/logger.js', () => ({ logger }));
  return import('../src/core/groups-config.js');
}

describe('groups config loader', () => {
  afterEach(() => {
    vi.doUnmock('../src/utils/paths.js');
    vi.doUnmock('../src/middleware/logger.js');
  });

  it('falls back to empty config and warns once when config/groups.json is missing', async () => {
    const projectRoot = tempProjectRoot();
    try {
      const configPath = join(projectRoot, 'config', 'groups.json');
      const groupsConfig = await loadGroupsConfig(projectRoot);

      expect(groupsConfig.GROUP_IDS).toEqual({});
      expect(groupsConfig.MENTION_PATTERNS).toEqual([]);
      expect(groupsConfig.getGroupName('missing@g.us')).toBe('Unknown Group');
      expect(groupsConfig.getEnabledGroupJidByName('General')).toBeNull();
      expect(groupsConfig.isGroupEnabled('missing@g.us')).toBe(false);
      expect(groupsConfig.requiresMention('missing@g.us')).toBe(true);
      expect(groupsConfig.isFeatureEnabled('missing@g.us', 'summary')).toBe(true);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { path: configPath },
        'Groups config file not found; using empty groups config',
      );
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('falls back to empty config and logs a clear error when config/groups.json is malformed', async () => {
    const projectRoot = tempProjectRoot();
    try {
      const configDir = join(projectRoot, 'config');
      const configPath = join(configDir, 'groups.json');
      mkdirSync(configDir);
      writeFileSync(configPath, '{not-json', 'utf-8');

      const groupsConfig = await loadGroupsConfig(projectRoot);

      expect(groupsConfig.GROUP_IDS).toEqual({});
      expect(groupsConfig.MENTION_PATTERNS).toEqual([]);
      expect(groupsConfig.getGroupPersona('missing@g.us')).toBeUndefined();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [meta, message] = logger.error.mock.calls[0] ?? [];
      expect(meta).toMatchObject({ path: configPath });
      expect(meta).toHaveProperty('reason');
      expect(String((meta as { reason?: unknown }).reason)).not.toContain('\n');
      expect(String(message)).toBe('Failed to load groups config; using empty groups config');
      // The one-line reason names the parse problem without dumping a stack
      expect(String((meta as { reason?: unknown }).reason)).not.toMatch(/\n|    at /);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('falls back to empty config and logs a clear error when config/groups.json is schema-invalid', async () => {
    const projectRoot = tempProjectRoot();
    try {
      const configDir = join(projectRoot, 'config');
      const configPath = join(configDir, 'groups.json');
      mkdirSync(configDir);
      writeFileSync(
        configPath,
        JSON.stringify({
          groups: {
            'general@g.us': {
              name: 'General',
              enabled: true,
              requireMention: false,
            },
          },
        }),
        'utf-8',
      );

      const groupsConfig = await loadGroupsConfig(projectRoot);

      expect(groupsConfig.GROUP_IDS).toEqual({});
      expect(groupsConfig.MENTION_PATTERNS).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [meta, message] = logger.error.mock.calls[0] ?? [];
      expect(meta).toMatchObject({ path: configPath });
      expect(String((meta as { reason?: unknown }).reason)).toContain('schema validation failed');
      expect(String((meta as { reason?: unknown }).reason)).not.toContain('\n');
      expect(String(message)).toBe('Failed to load groups config; using empty groups config');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('loads a valid config/groups.json with the existing public behavior', async () => {
    const projectRoot = tempProjectRoot();
    try {
      const configDir = join(projectRoot, 'config');
      mkdirSync(configDir);
      writeFileSync(
        join(configDir, 'groups.json'),
        JSON.stringify({
          groups: {
            'general@g.us': {
              name: 'General',
              enabled: true,
              requireMention: false,
              enabledFeatures: ['summary'],
              persona: 'host',
            },
            'quiet@g.us': {
              name: 'Quiet',
              enabled: false,
              requireMention: true,
            },
          },
          mentionPatterns: ['@garbanzo'],
          admins: {
            owner: { name: 'Owner', jid: 'owner@s.whatsapp.net' },
            moderators: [{ name: 'Mod' }],
          },
        }),
        'utf-8',
      );

      const groupsConfig = await loadGroupsConfig(projectRoot);

      expect(groupsConfig.GROUP_IDS['general@g.us']?.name).toBe('General');
      expect(groupsConfig.MENTION_PATTERNS).toEqual(['@garbanzo']);
      expect(groupsConfig.isGroupEnabled('general@g.us')).toBe(true);
      expect(groupsConfig.isGroupEnabled('quiet@g.us')).toBe(false);
      expect(groupsConfig.getGroupName('general@g.us')).toBe('General');
      expect(groupsConfig.getGroupName('unknown@g.us')).toBe('Unknown Group');
      expect(groupsConfig.getEnabledGroupJidByName('General')).toBe('general@g.us');
      expect(groupsConfig.getEnabledGroupJidByName('Quiet')).toBeNull();
      expect(groupsConfig.requiresMention('general@g.us')).toBe(false);
      expect(groupsConfig.requiresMention('quiet@g.us')).toBe(true);
      expect(groupsConfig.getGroupPersona('general@g.us')).toBe('host');
      expect(groupsConfig.isFeatureEnabled('general@g.us', 'summary')).toBe(true);
      expect(groupsConfig.isFeatureEnabled('general@g.us', 'events')).toBe(false);
      expect(groupsConfig.isFeatureEnabled('quiet@g.us', 'events')).toBe(true);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('resolves display names through a platform-registered resolver', async () => {
    const groupsConfig = await loadGroupsConfig(mkdtempSync(join(tmpdir(), 'garbanzo-groups-')));

    // No groups.json entry and no resolver: legacy fallback.
    expect(groupsConfig.getChatDisplayName('123456789012345678')).toBe('Unknown Group');

    // A platform runtime registers its own resolver (e.g. Discord channel names).
    groupsConfig.registerChatNameResolver((chatId) => (chatId === '123456789012345678' ? 'songwriting' : undefined));
    expect(groupsConfig.getChatDisplayName('123456789012345678')).toBe('songwriting');

    // Unresolvable ids and empty resolver results keep the legacy fallback.
    expect(groupsConfig.getChatDisplayName('999')).toBe('Unknown Group');
    groupsConfig.registerChatNameResolver(() => '');
    expect(groupsConfig.getChatDisplayName('123456789012345678')).toBe('Unknown Group');
  });
});
