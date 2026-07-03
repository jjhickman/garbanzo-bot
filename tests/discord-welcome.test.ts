process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('buildDiscordWelcomeMessage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('uses Discord member mentions and the configured channel name', async () => {
    const getDiscordChannelName = vi.fn(() => 'introductions');

    vi.doMock('../src/platforms/discord/discord-config.js', () => ({
      getDiscordChannelName,
    }));

    const { buildDiscordWelcomeMessage } = await import('../src/platforms/discord/welcome.js');

    const message = buildDiscordWelcomeMessage({
      channelId: 'intro-chan',
      memberUserId: 'USERID',
      memberDisplayName: 'New Member',
    });

    expect(getDiscordChannelName).toHaveBeenCalledWith('intro-chan');
    expect(message).toContain('<@USERID>');
    expect(message).toContain('introductions');
    expect(message).not.toContain('Unknown Group');
  });
});
