process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalChannelsConfigPath = process.env.DISCORD_CHANNELS_CONFIG_PATH;
const originalDiscordOwnerId = process.env.DISCORD_OWNER_ID;

function writeFixture(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'garbanzo-discord-config-'));
  const path = join(dir, 'discord-channels.json');
  writeFileSync(path, JSON.stringify(body), 'utf8');
  return path;
}

async function importDiscordConfig(path: string, ownerId = '111') {
  vi.resetModules();
  process.env.DISCORD_CHANNELS_CONFIG_PATH = path;
  process.env.DISCORD_OWNER_ID = ownerId;
  return import('../src/platforms/discord/discord-config.js');
}

describe('Discord channel config', () => {
  afterEach(() => {
    vi.resetModules();
    if (originalChannelsConfigPath === undefined) {
      delete process.env.DISCORD_CHANNELS_CONFIG_PATH;
    } else {
      process.env.DISCORD_CHANNELS_CONFIG_PATH = originalChannelsConfigPath;
    }
    if (originalDiscordOwnerId === undefined) {
      delete process.env.DISCORD_OWNER_ID;
    } else {
      process.env.DISCORD_OWNER_ID = originalDiscordOwnerId;
    }
  });

  it('disables unknown and explicitly disabled channels', async () => {
    const path = writeFixture({
      channels: {
        'chan-enabled': { name: 'general' },
        'chan-disabled': { name: 'quiet', enabled: false },
      },
    });
    const discordConfig = await importDiscordConfig(path);

    expect(discordConfig.isDiscordChannelEnabled('chan-enabled')).toBe(true);
    expect(discordConfig.isDiscordChannelEnabled('chan-disabled')).toBe(false);
    expect(discordConfig.isDiscordChannelEnabled('missing')).toBe(false);

    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('defaults requireMention to true and allows explicit false', async () => {
    const path = writeFixture({
      channels: {
        'chan-default': { name: 'general' },
        'chan-open': { name: 'bot-talk', requireMention: false },
      },
    });
    const discordConfig = await importDiscordConfig(path);

    expect(discordConfig.discordChannelRequiresMention('chan-default')).toBe(true);
    expect(discordConfig.discordChannelRequiresMention('chan-open')).toBe(false);
    expect(discordConfig.discordChannelRequiresMention('missing')).toBe(true);

    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('gates features only when a channel features array is present', async () => {
    const path = writeFixture({
      channels: {
        'chan-all': { name: 'general' },
        'chan-gated': { name: 'events', features: ['events', 'weather'] },
      },
    });
    const discordConfig = await importDiscordConfig(path);

    expect(discordConfig.isDiscordFeatureEnabled('chan-all', 'venues')).toBe(true);
    expect(discordConfig.isDiscordFeatureEnabled('chan-gated', 'events')).toBe(true);
    expect(discordConfig.isDiscordFeatureEnabled('chan-gated', 'venues')).toBe(false);
    expect(discordConfig.isDiscordFeatureEnabled('missing', 'events')).toBe(false);

    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('reads channel names, introduction/event channels, and band roles', async () => {
    const path = writeFixture({
      ownerId: 'file-owner',
      bandRoleIds: ['role-global'],
      introductionsChannelId: 'chan-intros',
      eventsChannelId: 'chan-events',
      channels: {
        'chan-intros': { name: 'introductions', bandRoleIds: ['role-local'] },
        'chan-events': { name: 'events' },
      },
    });
    const discordConfig = await importDiscordConfig(path);

    expect(discordConfig.getDiscordChannelName('chan-intros')).toBe('introductions');
    expect(discordConfig.getDiscordChannelName('missing')).toBeUndefined();
    expect(discordConfig.getDiscordIntroductionsChannelId()).toBe('chan-intros');
    expect(discordConfig.getDiscordEventsChannelId()).toBe('chan-events');
    expect(discordConfig.isBandMember(['role-other', 'role-global'])).toBe(true);
    expect(discordConfig.isBandMember(['role-local'])).toBe(false);
    expect(discordConfig.isBandMember(['role-other'])).toBe(false);

    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('prefers owner id from env before file owner id', async () => {
    const path = writeFixture({
      ownerId: 'file-owner',
      channels: {},
    });
    const withEnvOwner = await importDiscordConfig(path, '111');

    expect(withEnvOwner.getDiscordOwnerId()).toBe('111');

    vi.resetModules();
    process.env.DISCORD_CHANNELS_CONFIG_PATH = path;
    delete process.env.DISCORD_OWNER_ID;
    const withFileOwner = await import('../src/platforms/discord/discord-config.js');

    expect(withFileOwner.getDiscordOwnerId()).toBe('file-owner');

    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('uses disabled defaults when the file is absent', async () => {
    const discordConfig = await importDiscordConfig(join(tmpdir(), 'missing-discord-channels.json'));

    expect(discordConfig.getDiscordOwnerId()).toBe('111');
    expect(discordConfig.isDiscordChannelEnabled('chan-any')).toBe(false);
    expect(discordConfig.discordChannelRequiresMention('chan-any')).toBe(true);
    expect(discordConfig.isDiscordFeatureEnabled('chan-any', 'events')).toBe(false);
    expect(discordConfig.getDiscordChannelName('chan-any')).toBeUndefined();
    expect(discordConfig.isBandMember(['role-global'])).toBe(false);
    expect(discordConfig.getDiscordIntroductionsChannelId()).toBeNull();
    expect(discordConfig.getDiscordEventsChannelId()).toBeNull();
  });
});
