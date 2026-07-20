process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformMessenger } from '../src/core/platform-messenger.js';

const OWNER_ID = 'owner-user-111';
const BAND_MEMBER_ID = 'band-member-222';
const REGULAR_ID = 'regular-333';

function setupMocks(bandFeaturesEnabled: boolean) {
  const eventMock = vi.fn(async (args: string) => `event-handled:${args}`);
  const getResponseMock = vi.fn(async () => 'ai response');

  vi.doMock('../src/middleware/logger.js', () => ({
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

  vi.doMock('../src/utils/config.js', () => ({
    PROJECT_ROOT: '/tmp',
    config: {
      OWNER_JID: OWNER_ID,
      MESSAGING_PLATFORM: 'discord',
      DB_DIALECT: 'sqlite',
      BAND_FEATURES_ENABLED: bandFeaturesEnabled,
    },
  }));

  vi.doMock('../src/middleware/rate-limit.js', () => ({
    checkRateLimit: vi.fn(() => null),
    recordResponse: vi.fn(),
  }));

  vi.doMock('../src/middleware/stats.js', () => ({
    recordBotResponse: vi.fn(),
  }));

  vi.doMock('../src/middleware/retry.js', () => ({
    queueRetry: vi.fn(),
  }));

  vi.doMock('../src/features/links.js', () => ({
    extractUrls: vi.fn(() => []),
    processUrl: vi.fn(async () => null),
  }));

  vi.doMock('../src/features/memory-extract.js', () => ({
    maybeExtractCommunityFacts: vi.fn(async () => undefined),
  }));

  vi.doMock('../src/features/moderation.js', () => ({
    isSoftMuted: vi.fn(() => false),
  }));

  vi.doMock('../src/features/native-events.js', () => ({
    handleNativeEventCommand: eventMock,
  }));

  vi.doMock('../src/core/response-router.js', () => ({
    getResponse: getResponseMock,
  }));

  return { eventMock, getResponseMock };
}

function makeMessenger(calls: Array<{ type: string; to: string; payload: unknown }>): PlatformMessenger {
  return {
    platform: 'discord',
    async sendText(to: string, text: string): Promise<void> {
      calls.push({ type: 'text', to, payload: text });
    },
    async sendTextWithRef(to: string, text: string): Promise<unknown> {
      calls.push({ type: 'textRef', to, payload: text });
      return { key: { id: 'sent', remoteJid: to } };
    },
    async sendPoll(): Promise<void> {
      // not used
    },
    async sendDocument(): Promise<unknown> {
      return { key: { id: 'doc1' } };
    },
    async sendAudio(): Promise<void> {
      // not used
    },
    async deleteMessage(): Promise<void> {
      // not used
    },
  } as unknown as PlatformMessenger;
}

async function dispatch(senderId: string, opts: { bandFlag: boolean; senderIsBandMember?: boolean }) {
  const { eventMock, getResponseMock } = setupMocks(opts.bandFlag);
  const { processGroupMessage } = await import('../src/core/process-group-message.js');

  const calls: Array<{ type: string; to: string; payload: unknown }> = [];
  await processGroupMessage({
    messenger: makeMessenger(calls),
    chatId: 'chan-1',
    senderId,
    groupName: 'General',
    ownerId: 'owner-dm-channel',
    ownerUserId: OWNER_ID,
    senderIsBandMember: opts.senderIsBandMember,
    query: '!event list',
    isFeatureEnabled: () => true,
    getResponse: getResponseMock,
  });

  return { eventMock, getResponseMock, calls };
}

describe('!event routing (owner/band gating)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('routes !event to the handler for the owner even without band features', async () => {
    const { eventMock, getResponseMock, calls } = await dispatch(OWNER_ID, { bandFlag: false });

    expect(eventMock).toHaveBeenCalledWith('list', expect.objectContaining({ chatId: 'chan-1', senderId: OWNER_ID }));
    expect(getResponseMock).not.toHaveBeenCalled();
    expect(calls).toEqual([{ type: 'text', to: 'chan-1', payload: 'event-handled:list' }]);
  });

  it('routes !event for a band member when BAND_FEATURES_ENABLED is true', async () => {
    const { eventMock, calls } = await dispatch(BAND_MEMBER_ID, { bandFlag: true, senderIsBandMember: true });

    expect(eventMock).toHaveBeenCalledWith('list', expect.objectContaining({ senderId: BAND_MEMBER_ID }));
    expect(calls).toEqual([{ type: 'text', to: 'chan-1', payload: 'event-handled:list' }]);
  });

  it('declines a band member when BAND_FEATURES_ENABLED is false', async () => {
    const { eventMock, getResponseMock, calls } = await dispatch(BAND_MEMBER_ID, {
      bandFlag: false,
      senderIsBandMember: true,
    });

    expect(eventMock).not.toHaveBeenCalled();
    expect(getResponseMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.payload)).toMatch(/owner|band/i);
  });

  it('declines a regular sender with the standard not-allowed reply', async () => {
    const { eventMock, getResponseMock, calls } = await dispatch(REGULAR_ID, { bandFlag: true });

    expect(eventMock).not.toHaveBeenCalled();
    expect(getResponseMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.payload)).toMatch(/owner|band/i);
  });
});
