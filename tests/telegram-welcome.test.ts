process.env.MESSAGING_PLATFORM ??= 'telegram';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.TELEGRAM_OWNER_ID ??= '111';
process.env.TELEGRAM_BOT_TOKEN ??= 'test_tg_token';

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('buildTelegramWelcomeMessage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('uses the display name and configured chat name', async () => {
    const getTelegramChatName = vi.fn(() => 'general');

    vi.doMock('../src/platforms/telegram/telegram-config.js', () => ({
      getTelegramChatName,
    }));

    const { buildTelegramWelcomeMessage } = await import('../src/platforms/telegram/welcome.js');

    const message = buildTelegramWelcomeMessage({
      chatId: 'chat-1',
      memberUserId: '555',
      memberDisplayName: 'New Member',
    });

    expect(getTelegramChatName).toHaveBeenCalledWith('chat-1');
    expect(message).toContain('New Member');
    expect(message).toContain('general');
  });

  it('falls back to a generic "user <id>" label and "the group" when nothing else is known', async () => {
    const getTelegramChatName = vi.fn(() => undefined);

    vi.doMock('../src/platforms/telegram/telegram-config.js', () => ({
      getTelegramChatName,
    }));

    const { buildTelegramWelcomeMessage } = await import('../src/platforms/telegram/welcome.js');

    const message = buildTelegramWelcomeMessage({
      chatId: 'chat-1',
      memberUserId: '555',
    });

    expect(message).toContain('user 555');
    expect(message).toContain('the group');
  });
});
