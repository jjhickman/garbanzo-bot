process.env.MESSAGING_PLATFORM ??= 'telegram';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.TELEGRAM_OWNER_ID ??= '111';
process.env.TELEGRAM_BOT_TOKEN ??= 'test_tg_token';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// F6 (T2 review): TELEGRAM_CHAT_SCOPE wiring, mirroring the WhatsApp
// processor's WHATSAPP_CHAT_SCOPE wiring test (tests/whatsapp-chat-scope.test.ts) —
// the platform-agnostic gating mechanism itself (shouldIngestGroupChat) is
// already covered there; this only pins the Telegram-specific hook wiring
// and its DEFAULT ('configured', deliberately different from WhatsApp's
// 'all' default).

function mockProcessorDeps(chatScope: 'all' | 'configured') {
  const processInboundMessage = vi.fn(async () => undefined);
  const isTelegramChatEnabled = vi.fn((chatId: string) => chatId === 'configured-chat');

  vi.doMock('../src/core/process-inbound-message.js', () => ({ processInboundMessage }));
  // processor.ts imports processGroupMessage from core directly (unlike
  // WhatsApp's processor.ts, which delegates to a platform-specific,
  // separately-mocked group-handler.js) — without mocking this out, the
  // real module graph pulls in src/utils/db.ts, which needs a full DB_DIALECT
  // config this test's minimal config stub doesn't provide.
  vi.doMock('../src/core/process-group-message.js', () => ({ processGroupMessage: vi.fn(async () => undefined) }));
  vi.doMock('../src/utils/config.js', () => ({
    config: {
      MESSAGING_PLATFORM: 'telegram',
      TELEGRAM_CHAT_SCOPE: chatScope,
    },
  }));
  vi.doMock('../src/middleware/logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('../src/features/voice.js', () => ({ transcribeAudio: vi.fn(async () => null) }));
  vi.doMock('../src/platforms/telegram/telegram-config.js', () => ({
    isTelegramChatEnabled,
    telegramChatRequiresMention: vi.fn(() => false),
    isTelegramFeatureEnabled: vi.fn(() => true),
    getTelegramChatName: vi.fn(() => undefined),
  }));
  vi.doMock('../src/core/response-router.js', () => ({ getResponse: vi.fn(async () => 'ok') }));
  vi.doMock('../src/bridge/capture-hook.js', () => ({ captureForBridge: vi.fn() }));

  return { processInboundMessage, isTelegramChatEnabled };
}

function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: 'msg-1',
    chatId: 'configured-chat',
    isGroupChat: true,
    text: 'hello',
    senderId: 'user-1',
    timestampMs: Date.now(),
    ...overrides,
  };
}

describe('Telegram processor chat-scope hook wiring (F6)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('passes isTelegramChatEnabled as the ingestion hook when TELEGRAM_CHAT_SCOPE=configured', async () => {
    const { processInboundMessage, isTelegramChatEnabled } = mockProcessorDeps('configured');
    const { processTelegramEvent } = await import('../src/platforms/telegram/processor.js');

    await processTelegramEvent(
      { sendText: vi.fn(async () => undefined) } as never,
      baseEvent(),
      { ownerId: 'owner-chat', ownerUserId: '111' },
    );

    const env = processInboundMessage.mock.calls[0]?.[3] as { shouldIngestGroupChat?: (chatId: string) => boolean } | undefined;
    expect(env?.shouldIngestGroupChat).toBe(isTelegramChatEnabled);
  });

  it('does not pass an ingestion hook when TELEGRAM_CHAT_SCOPE=all', async () => {
    const { processInboundMessage } = mockProcessorDeps('all');
    const { processTelegramEvent } = await import('../src/platforms/telegram/processor.js');

    await processTelegramEvent(
      { sendText: vi.fn(async () => undefined) } as never,
      baseEvent(),
      { ownerId: 'owner-chat', ownerUserId: '111' },
    );

    const env = processInboundMessage.mock.calls[0]?.[3] as { shouldIngestGroupChat?: (chatId: string) => boolean } | undefined;
    expect(env?.shouldIngestGroupChat).toBeUndefined();
  });

  it('defaults TELEGRAM_CHAT_SCOPE to configured in the real env schema', async () => {
    vi.resetModules();
    const { telegramSchema } = await import('../src/utils/config/telegram.js');
    const parsed = telegramSchema.parse({});
    expect(parsed.TELEGRAM_CHAT_SCOPE).toBe('configured');
  });
});
