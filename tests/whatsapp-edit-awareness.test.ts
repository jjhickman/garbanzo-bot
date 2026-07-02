process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';

describe('WhatsApp edit unwrapping', async () => {
  const { normalizeWhatsAppInboundMessage } = await import('../src/platforms/whatsapp/inbound.js');
  const sock = {} as WASocket;

  function editMessage(): WAMessage {
    return {
      key: { remoteJid: '123@g.us', participant: 'user@s.whatsapp.net', id: 'EDIT-1' },
      message: {
        protocolMessage: {
          type: 14, // MESSAGE_EDIT
          key: { remoteJid: '123@g.us', id: 'ORIG-1' },
          editedMessage: { conversation: 'corrected text' },
        },
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
    } as unknown as WAMessage;
  }

  it('extracts the edited text and the original message id', () => {
    const inbound = normalizeWhatsAppInboundMessage(sock, editMessage());
    expect(inbound?.text).toBe('corrected text');
    expect(inbound?.editOfMessageId).toBe('ORIG-1');
    expect(inbound?.messageId).toBe('EDIT-1');
  });

  it('leaves normal messages untouched', () => {
    const msg = {
      key: { remoteJid: '123@g.us', id: 'M1' },
      message: { conversation: 'hello' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    } as unknown as WAMessage;
    const inbound = normalizeWhatsAppInboundMessage(sock, msg);
    expect(inbound?.text).toBe('hello');
    expect(inbound?.editOfMessageId).toBeUndefined();
  });

  it('ignores non-edit protocol messages (e.g. deletes)', () => {
    const msg = {
      key: { remoteJid: '123@g.us', id: 'M2' },
      message: { protocolMessage: { type: 0, key: { id: 'ORIG-2' } } }, // REVOKE
      messageTimestamp: Math.floor(Date.now() / 1000),
    } as unknown as WAMessage;
    const inbound = normalizeWhatsAppInboundMessage(sock, msg);
    expect(inbound?.text).toBeNull();
    expect(inbound?.editOfMessageId).toBeUndefined();
  });
});

describe('core pipeline edit handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  const checkMessage = vi.fn();
  const handleIntroduction = vi.fn();

  function mockPipelineDeps(flag: { reason: string; severity: string; source: string } | null) {
    checkMessage.mockReset();
    checkMessage.mockResolvedValue(flag);
    handleIntroduction.mockReset();
    handleIntroduction.mockResolvedValue(null);

    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../src/features/moderation.js', () => ({
      checkMessage,
      formatModerationAlert: vi.fn(() => 'ALERT'),
      applyStrikeAndMute: vi.fn(() => ({ muted: false, dmMessage: null })),
    }));
    vi.doMock('../src/middleware/sanitize.js', () => ({
      sanitizeMessage: vi.fn((t: string) => ({ text: t, rejected: false })),
    }));
    vi.doMock('../src/utils/db.js', () => ({
      touchProfile: vi.fn(async () => undefined),
      updateActiveGroups: vi.fn(async () => undefined),
      logModeration: vi.fn(async () => undefined),
      getStrikeCount: vi.fn(async () => 0),
    }));
    vi.doMock('../src/middleware/context.js', () => ({ recordMessage: vi.fn(async () => undefined) }));
    vi.doMock('../src/middleware/stats.js', () => ({
      recordGroupMessage: vi.fn(),
      recordModerationFlag: vi.fn(),
    }));
  }

  function makeInbound(overrides: Record<string, unknown>) {
    return {
      platform: 'whatsapp',
      chatId: 'group@g.us',
      senderId: 'user@s.whatsapp.net',
      messageId: 'EDIT-9',
      fromSelf: false,
      isStatusBroadcast: false,
      isGroupChat: true,
      timestampMs: Date.now(),
      text: 'edited content',
      hasVisualMedia: false,
      raw: { platform: 'whatsapp', chatId: 'group@g.us', id: 'EDIT-9' },
      ...overrides,
    };
  }

  function makeHooks() {
    return {
      isReplyToBot: vi.fn(() => true),
      isAcknowledgment: vi.fn(() => true),
      sendAcknowledgmentReaction: vi.fn(async () => undefined),
      handleGroupMessage: vi.fn(async () => undefined),
      handleOwnerDM: vi.fn(async () => undefined),
    };
  }

  function makeEnv(overrides: Record<string, unknown> = {}) {
    return {
      ownerId: 'owner@s.whatsapp.net',
      isGroupEnabled: () => true,
      introductionsChatId: null,
      eventsChatId: null,
      handleIntroduction,
      handleEventPassive: vi.fn(async () => null),
      ...overrides,
    };
  }

  it('re-runs moderation on edited content and alerts the owner', async () => {
    mockPipelineDeps({ reason: 'bad', severity: 'high', source: 'regex' });
    const { processInboundMessage } = await import('../src/core/process-inbound-message.js');
    const adapter = { sendText: vi.fn(async () => undefined) };
    const hooks = makeHooks();

    await processInboundMessage(
      adapter as never,
      makeInbound({ editOfMessageId: 'ORIG-9' }) as never,
      hooks as never,
      makeEnv() as never,
    );

    expect(checkMessage).toHaveBeenCalledWith('edited content');
    expect(adapter.sendText).toHaveBeenCalledWith('owner@s.whatsapp.net', 'ALERT');
    expect(hooks.handleGroupMessage).not.toHaveBeenCalled();
    expect(hooks.sendAcknowledgmentReaction).not.toHaveBeenCalled();
  });

  it('re-runs intro classification with the ORIGINAL message id', async () => {
    mockPipelineDeps(null);
    const { processInboundMessage } = await import('../src/core/process-inbound-message.js');
    const adapter = { sendText: vi.fn(async () => undefined) };

    await processInboundMessage(
      adapter as never,
      makeInbound({ chatId: 'intros@g.us', editOfMessageId: 'ORIG-9' }) as never,
      makeHooks() as never,
      makeEnv({ introductionsChatId: 'intros@g.us' }) as never,
    );

    expect(handleIntroduction).toHaveBeenCalledWith('edited content', 'ORIG-9', 'user@s.whatsapp.net', 'intros@g.us');
  });

  it('never dispatches replies for edits, but does for normal messages', async () => {
    mockPipelineDeps(null);
    const { processInboundMessage } = await import('../src/core/process-inbound-message.js');
    const adapter = { sendText: vi.fn(async () => undefined) };

    const editHooks = makeHooks();
    await processInboundMessage(
      adapter as never,
      makeInbound({ editOfMessageId: 'ORIG-9' }) as never,
      editHooks as never,
      makeEnv() as never,
    );
    expect(editHooks.handleGroupMessage).not.toHaveBeenCalled();

    const normalHooks = makeHooks();
    normalHooks.isReplyToBot.mockReturnValue(false);
    normalHooks.isAcknowledgment.mockReturnValue(false);
    await processInboundMessage(
      adapter as never,
      makeInbound({}) as never,
      normalHooks as never,
      makeEnv() as never,
    );
    expect(normalHooks.handleGroupMessage).toHaveBeenCalledTimes(1);
  });
});
