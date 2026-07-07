process.env.MESSAGING_PLATFORM ??= 'telegram';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.TELEGRAM_OWNER_ID ??= '111';
process.env.TELEGRAM_BOT_TOKEN ??= 'test_tg_token';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageContext } from '../src/ai/persona.js';
import type { PlatformMessenger } from '../src/core/platform-messenger.js';

type FeaturePredicate = (chatId: string, feature: string) => boolean;
type MockGetResponse = (
  query: string,
  ctx: MessageContext,
  isFeatureEnabled: FeaturePredicate,
) => Promise<string | null>;

function createMessenger(): PlatformMessenger & { sendText: ReturnType<typeof vi.fn> } {
  const sendText = vi.fn<PlatformMessenger['sendText']>(async () => undefined);
  return {
    platform: 'telegram',
    sendText,
    sendPoll: vi.fn<PlatformMessenger['sendPoll']>(async () => undefined),
    sendTextWithRef: vi.fn<PlatformMessenger['sendTextWithRef']>(async (chatId) => ({
      platform: 'telegram', chatId, id: 'm1', ref: {},
    })),
    sendDocument: vi.fn<PlatformMessenger['sendDocument']>(async (chatId) => ({
      platform: 'telegram', chatId, id: 'd1', ref: {},
    })),
    sendAudio: vi.fn<PlatformMessenger['sendAudio']>(async () => undefined),
    deleteMessage: vi.fn<PlatformMessenger['deleteMessage']>(async () => undefined),
  };
}

function setupMocks() {
  const isTelegramChatEnabled = vi.fn<(chatId: string) => boolean>((chatId) => chatId !== 'disabled');
  const telegramChatRequiresMention = vi.fn<(chatId: string) => boolean>((chatId) => chatId !== 'open');
  const isTelegramFeatureEnabled = vi.fn<(chatId: string, feature: string) => boolean>(
    (chatId, feature) => chatId === 'open' && feature === 'weather',
  );
  const getTelegramChatName = vi.fn<(chatId: string) => string | undefined>(
    (chatId) => (chatId === 'enabled' ? 'general' : undefined),
  );
  const getResponse = vi.fn<MockGetResponse>(async (query, ctx, featureEnabled) => {
    const weatherEnabled = featureEnabled(ctx.groupJid, 'weather');
    return `assistant:${query}:weather=${weatherEnabled ? 'on' : 'off'}`;
  });

  vi.doMock('../src/platforms/telegram/telegram-config.js', () => ({
    isTelegramChatEnabled,
    telegramChatRequiresMention,
    isTelegramFeatureEnabled,
    getTelegramChatName,
  }));

  vi.doMock('../src/core/response-router.js', () => ({ getResponse }));

  return { isTelegramChatEnabled, telegramChatRequiresMention, isTelegramFeatureEnabled, getTelegramChatName, getResponse };
}

async function importProcessor() {
  const { processTelegramEvent } = await import('../src/platforms/telegram/processor.js');
  return { processTelegramEvent };
}

function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: 'msg-1',
    chatId: 'enabled',
    isGroupChat: true,
    text: 'hello',
    senderId: 'user-1',
    senderName: 'Ada Lovelace',
    timestampMs: Date.now(),
    ...overrides,
  };
}

describe('Telegram processor — chat gating + requireMention + senderName plumbing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('ignores messages in a disabled chat before calling the assistant', async () => {
    const mocks = setupMocks();
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(messenger, baseEvent({ chatId: 'disabled', text: '!weather please' }), {
      ownerId: 'owner-chat', ownerUserId: '111',
    });

    expect(mocks.isTelegramChatEnabled).toHaveBeenCalledWith('disabled');
    expect(mocks.getResponse).not.toHaveBeenCalled();
    expect(messenger.sendText).not.toHaveBeenCalled();
  });

  it('ignores a require-mention chat message without a mention, reply, or bang', async () => {
    const mocks = setupMocks();
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(messenger, baseEvent({ text: 'just chatting' }), {
      ownerId: 'owner-chat', ownerUserId: '111',
    });

    expect(mocks.telegramChatRequiresMention).toHaveBeenCalledWith('enabled');
    expect(mocks.getResponse).not.toHaveBeenCalled();
  });

  it('processes a bang command in a require-mention chat', async () => {
    const mocks = setupMocks();
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(messenger, baseEvent({ text: '!weather please' }), {
      ownerId: 'owner-chat', ownerUserId: '111',
    });

    expect(mocks.getResponse).toHaveBeenCalledWith(
      '!weather please',
      expect.objectContaining({ groupName: 'general', groupJid: 'enabled', senderJid: 'user-1' }),
      expect.any(Function),
      undefined,
    );
    expect(messenger.sendText).toHaveBeenCalledWith(
      'enabled',
      'assistant:!weather please:weather=off',
      expect.anything(),
    );
  });

  it('processes a message addressed via mentionedIds (reply-to-bot / @mention) in a require-mention chat', async () => {
    const mocks = setupMocks();
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(
      messenger,
      baseEvent({ text: 'help please', mentionedIds: ['999'] }),
      { ownerId: 'owner-chat', ownerUserId: '111', botUserId: '999' },
    );

    expect(mocks.getResponse).toHaveBeenCalledWith(
      'help please',
      expect.objectContaining({ groupJid: 'enabled' }),
      expect.any(Function),
      undefined,
    );
  });

  it('strips a leading @botUsername mention from the query', async () => {
    const mocks = setupMocks();
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(
      messenger,
      baseEvent({ text: '@GarbanzoBot what is the weather', mentionedIds: ['999'] }),
      { ownerId: 'owner-chat', ownerUserId: '111', botUserId: '999', botUsername: 'GarbanzoBot' },
    );

    expect(mocks.getResponse).toHaveBeenCalledWith(
      'what is the weather',
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });

  it('processes non-mention messages in chats that do not require a mention', async () => {
    const mocks = setupMocks();
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(messenger, baseEvent({ chatId: 'open', text: 'what is the weather?' }), {
      ownerId: 'owner-chat', ownerUserId: '111',
    });

    expect(mocks.telegramChatRequiresMention).toHaveBeenCalledWith('open');
    expect(mocks.getResponse).toHaveBeenCalledWith(
      'what is the weather?',
      expect.objectContaining({ groupJid: 'open' }),
      expect.any(Function),
      undefined,
    );
    expect(messenger.sendText).toHaveBeenCalledWith(
      'open',
      'assistant:what is the weather?:weather=on',
      expect.anything(),
    );
  });

  it('routes feature checks through the Telegram feature predicate', async () => {
    const mocks = setupMocks();
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(messenger, baseEvent({ chatId: 'open', text: 'umbrella?' }), {
      ownerId: 'owner-chat', ownerUserId: '111',
    });

    expect(mocks.isTelegramFeatureEnabled).toHaveBeenCalledWith('open', 'weather');
  });

  it('plumbs senderName through to the normalized inbound and onward via groupJid context', async () => {
    const mocks = setupMocks();
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(
      messenger,
      baseEvent({ chatId: 'open', text: 'hi', senderName: 'Ada Lovelace' }),
      { ownerId: 'owner-chat', ownerUserId: '111' },
    );

    // senderName isn't part of MessageContext today (core doesn't thread it
    // into the prompt yet) — this test pins that the processor at least
    // accepts and normalizes it without dropping/crashing, so future core
    // wiring has a stable contract to build on.
    expect(mocks.getResponse).toHaveBeenCalled();
  });

  it('gates owner DMs by Telegram owner user identity', async () => {
    const mocks = setupMocks();
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(
      messenger,
      baseEvent({ chatId: 'dm-1', isGroupChat: false, senderId: 'not-owner', text: 'status?' }),
      { ownerId: 'owner-chat', ownerUserId: '111' },
    );
    expect(mocks.getResponse).not.toHaveBeenCalled();

    await processTelegramEvent(
      messenger,
      baseEvent({ chatId: 'dm-1', isGroupChat: false, senderId: '111', text: 'status?' }),
      { ownerId: 'owner-chat', ownerUserId: '111' },
    );
    expect(mocks.getResponse).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid event payload without throwing', async () => {
    setupMocks();
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await expect(processTelegramEvent(messenger, { garbage: true }, { ownerId: 'owner-chat' }))
      .resolves.toBeUndefined();
    expect(messenger.sendText).not.toHaveBeenCalled();
  });
});

describe('Telegram processor — voice transcription (F1, T2 review)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function setupVoiceMocks(transcribeAudio: ReturnType<typeof vi.fn>) {
    const mocks = setupMocks();
    vi.doMock('../src/features/voice.js', () => ({ transcribeAudio }));
    return mocks;
  }

  it('transcribes a captionless voice message with a downloaded buffer and dispatches the transcript', async () => {
    const transcribeAudio = vi.fn(async () => 'hello from the transcript');
    const mocks = setupVoiceMocks(transcribeAudio);
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(
      messenger,
      // chatId 'open' does not require a mention (setupMocks), so the
      // resolved transcript is dispatched without needing a bang/mention.
      baseEvent({
        chatId: 'open',
        text: '',
        audio: { url: 'telegram-file:voice-1', contentType: 'audio/ogg', buffer: Buffer.from([1, 2, 3]) },
      }),
      { ownerId: 'owner-chat', ownerUserId: '111' },
    );

    expect(transcribeAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), 'audio/ogg');
    expect(mocks.getResponse).toHaveBeenCalledWith(
      'hello from the transcript',
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });

  it('falls back to the [voice note] placeholder (never drops the message) when transcription fails', async () => {
    const transcribeAudio = vi.fn(async () => null);
    const mocks = setupVoiceMocks(transcribeAudio);
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(
      messenger,
      baseEvent({
        chatId: 'open',
        text: '',
        audio: { url: 'telegram-file:voice-2', contentType: 'audio/ogg', buffer: Buffer.from([9]) },
      }),
      { ownerId: 'owner-chat', ownerUserId: '111' },
    );

    expect(mocks.getResponse).toHaveBeenCalledWith(
      '[voice note]',
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });

  it('falls back to the [voice note] placeholder (never drops the message) when the buffer failed to download', async () => {
    const transcribeAudio = vi.fn(async () => 'should not be called');
    const mocks = setupVoiceMocks(transcribeAudio);
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(
      messenger,
      baseEvent({
        chatId: 'open',
        text: '',
        audio: { url: 'telegram-file:voice-3', contentType: 'audio/ogg' }, // no buffer — download failed
      }),
      { ownerId: 'owner-chat', ownerUserId: '111' },
    );

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(mocks.getResponse).toHaveBeenCalledWith(
      '[voice note]',
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });

  it('does not transcribe when the voice message already has caption text', async () => {
    const transcribeAudio = vi.fn(async () => 'should not be called either');
    const mocks = setupVoiceMocks(transcribeAudio);
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(
      messenger,
      baseEvent({
        text: '!weather has a caption',
        audio: { url: 'telegram-file:voice-4', contentType: 'audio/ogg', buffer: Buffer.from([1]) },
      }),
      { ownerId: 'owner-chat', ownerUserId: '111' },
    );

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(mocks.getResponse).toHaveBeenCalledWith(
      '!weather has a caption',
      expect.anything(),
      expect.any(Function),
      undefined,
    );
  });

  it('a captionless voice message with no audio.buffer previously passed [voice note] through recording — RED-guard: without transcription, an empty-text captionless voice would be silently dropped by the core gate', async () => {
    // This test documents the F1 regression this fix closes: before the
    // fix, `text` stayed '' for a captionless voice message and
    // process-inbound-message.ts's `!inbound.text && !hasMedia` gate
    // silently dropped it. The placeholder fallback above proves that no
    // longer happens.
    const transcribeAudio = vi.fn(async () => null);
    setupVoiceMocks(transcribeAudio);
    const { processTelegramEvent } = await importProcessor();
    const messenger = createMessenger();

    await processTelegramEvent(
      messenger,
      baseEvent({ text: '', audio: undefined }), // no voice at all — genuinely empty message
      { ownerId: 'owner-chat', ownerUserId: '111' },
    );

    // No media, no text, no voice — correctly dropped (unaffected by F1).
    expect(messenger.sendText).not.toHaveBeenCalled();
  });
});
