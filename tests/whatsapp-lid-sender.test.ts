import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import type { WAMessage, WASocket } from '@whiskeysockets/baileys';

const { resolveWhatsAppSenderJid, normalizeWhatsAppInboundMessage } =
  await import('../src/platforms/whatsapp/inbound.js');

function waMessage(key: Record<string, unknown>, text = 'hello'): WAMessage {
  return {
    key,
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  } as unknown as WAMessage;
}

const sock = {} as WASocket;

describe('LID sender resolution', () => {
  it('resolves a LID group participant to the phone JID via participantPn', () => {
    const msg = waMessage({
      remoteJid: '120363423357339667@g.us',
      participant: '184468458393129@lid',
      participantPn: '15551234567@s.whatsapp.net',
      id: 'A1',
    });
    expect(resolveWhatsAppSenderJid(msg, '120363423357339667@g.us')).toBe('15551234567@s.whatsapp.net');
  });

  it('resolves a LID DM sender to the phone JID via senderPn', () => {
    const msg = waMessage({
      remoteJid: '184468458393129@lid',
      senderPn: '15551234567@s.whatsapp.net',
      id: 'A2',
    });
    expect(resolveWhatsAppSenderJid(msg, '184468458393129@lid')).toBe('15551234567@s.whatsapp.net');
  });

  it('keeps the LID when no phone mapping is present', () => {
    const msg = waMessage({
      remoteJid: '120363423357339667@g.us',
      participant: '184468458393129@lid',
      id: 'A3',
    });
    expect(resolveWhatsAppSenderJid(msg, '120363423357339667@g.us')).toBe('184468458393129@lid');
  });

  it('leaves plain phone-JID senders untouched', () => {
    const msg = waMessage({
      remoteJid: '120363423357339667@g.us',
      participant: '15551234567@s.whatsapp.net',
      id: 'A4',
    });
    expect(resolveWhatsAppSenderJid(msg, '120363423357339667@g.us')).toBe('15551234567@s.whatsapp.net');
  });

  it('normalizeWhatsAppInboundMessage uses the resolved phone JID but keeps LID chatId for reply routing', () => {
    const msg = waMessage({
      remoteJid: '184468458393129@lid',
      senderPn: '15551234567@s.whatsapp.net',
      id: 'A5',
    });
    const inbound = normalizeWhatsAppInboundMessage(sock, msg);
    expect(inbound?.senderId).toBe('15551234567@s.whatsapp.net');
    expect(inbound?.chatId).toBe('184468458393129@lid'); // replies must target the original chat
  });
});

describe('owner match is LID/device tolerant', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function mockOwnerDeps() {
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../src/utils/config.js', () => ({
      config: { OWNER_JID: '15551234567@s.whatsapp.net' },
    }));
    vi.doMock('../src/features/help.js', () => ({
      getHelpMessage: vi.fn(() => 'help'),
      getOwnerHelpMessage: vi.fn(() => 'owner help'),
    }));
    vi.doMock('../src/platforms/whatsapp/introductions-catchup.js', () => ({ triggerIntroCatchUp: vi.fn(async () => 'ok') }));
    vi.doMock('../src/features/digest.js', () => ({ previewDigest: vi.fn(() => 'digest') }));
    vi.doMock('../src/features/moderation.js', () => ({ formatStrikesReport: vi.fn(() => 'strikes') }));
    vi.doMock('../src/features/feedback.js', () => ({
      handleFeedbackOwner: vi.fn(() => 'feedback'),
      createGitHubIssueFromFeedback: vi.fn(async () => 'issue'),
    }));
    vi.doMock('../src/features/release.js', () => ({ handleRelease: vi.fn(async () => 'release') }));
    vi.doMock('../src/features/memory.js', () => ({ handleMemory: vi.fn(() => 'memory') }));
    vi.doMock('../src/middleware/stats.js', () => ({ recordOwnerDM: vi.fn() }));
    vi.doMock('../src/core/response-router.js', () => ({ getResponse: vi.fn(async () => 'ai') }));
    vi.doMock('../src/platforms/whatsapp/outbound-safety.js', () => ({ getWhatsAppOutboundSafety: vi.fn(() => undefined) }));
    vi.doMock('../src/core/groups-config.js', () => ({ GROUP_IDS: {}, isFeatureEnabled: vi.fn(() => true) }));
  }

  it('accepts the owner with a device suffix', async () => {
    mockOwnerDeps();
    const { handleOwnerDM } = await import('../src/platforms/whatsapp/owner-commands.js');
    const sockMock = { sendMessage: vi.fn(async () => undefined) };
    const handled = await handleOwnerDM(
      sockMock as never,
      '15551234567@s.whatsapp.net',
      '15551234567:22@s.whatsapp.net',
      '!help',
    );
    expect(handled).toBe(true);
    expect(sockMock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('still rejects non-owners', async () => {
    mockOwnerDeps();
    const { handleOwnerDM } = await import('../src/platforms/whatsapp/owner-commands.js');
    const sockMock = { sendMessage: vi.fn(async () => undefined) };
    const handled = await handleOwnerDM(
      sockMock as never,
      '15559999999@s.whatsapp.net',
      '15559999999@s.whatsapp.net',
      '!help',
    );
    expect(handled).toBe(false);
    expect(sockMock.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects an unresolved LID sender (no phone mapping — cannot verify owner)', async () => {
    mockOwnerDeps();
    const { handleOwnerDM } = await import('../src/platforms/whatsapp/owner-commands.js');
    const sockMock = { sendMessage: vi.fn(async () => undefined) };
    const handled = await handleOwnerDM(
      sockMock as never,
      '184468458393129@lid',
      '184468458393129@lid',
      '!help',
    );
    expect(handled).toBe(false);
  });
});
