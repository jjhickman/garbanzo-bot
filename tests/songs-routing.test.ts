process.env.MESSAGING_PLATFORM ??= 'discord';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';
process.env.DISCORD_OWNER_ID ??= '111';
process.env.DISCORD_BOT_TOKEN ??= 'test_tok';
process.env.BAND_FEATURES_ENABLED ??= 'true';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformMessenger } from '../src/core/platform-messenger.js';
import type { PollPayload } from '../src/core/poll-payload.js';

const OWNER_ID = 'owner-user-111';
const BAND_MEMBER_ID = 'band-member-222';

function setupMocks(bandFeaturesEnabled: boolean) {
  const songMock = vi.fn(async (args: string) => `song-handled:${args}`);
  const getResponseMock = vi.fn(async () => 'ai response');

  vi.doMock('../src/middleware/logger.js', () => ({
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
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

  vi.doMock('../src/features/character.js', () => ({
    handleCharacter: vi.fn(async () => 'character not used'),
  }));

  vi.doMock('../src/features/voice.js', () => ({
    handleVoiceCommand: vi.fn(() => ({ action: 'list' })),
    formatVoiceList: vi.fn(() => ''),
    textToSpeech: vi.fn(async () => null),
    isTTSAvailable: vi.fn(() => false),
  }));

  vi.doMock('../src/features/feedback.js', () => ({
    handleFeedbackSubmit: vi.fn(async () => ({ response: 'feedback recorded' })),
    handleUpvote: vi.fn(async () => 'upvoted'),
  }));

  vi.doMock('../src/features/polls.js', () => ({
    handlePoll: vi.fn(() => 'poll help'),
    isDuplicatePoll: vi.fn(() => false),
    recordPoll: vi.fn(),
  }));

  vi.doMock('../src/features/songs.js', () => ({
    handleSongCommand: songMock,
  }));

  vi.doMock('../src/core/response-router.js', () => ({
    getResponse: getResponseMock,
  }));

  return { songMock, getResponseMock };
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
    async sendPoll(to: string, poll: PollPayload): Promise<void> {
      calls.push({ type: 'poll', to, payload: poll });
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
  };
}

describe('!song routing (band feature gating)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('routes !song to handleSongCommand for the owner when BAND_FEATURES_ENABLED is true', async () => {
    const { songMock, getResponseMock } = setupMocks(true);
    const { processGroupMessage } = await import('../src/core/process-group-message.js');

    const calls: Array<{ type: string; to: string; payload: unknown }> = [];
    const messenger = makeMessenger(calls);

    await processGroupMessage({
      messenger,
      chatId: 'band-channel',
      senderId: OWNER_ID,
      groupName: 'Band',
      ownerId: 'owner-dm-channel',
      ownerUserId: OWNER_ID,
      query: '!song list',
      isFeatureEnabled: () => true,
      getResponse: getResponseMock,
    });

    expect(songMock).toHaveBeenCalledWith('list');
    expect(getResponseMock).not.toHaveBeenCalled();
    expect(calls).toEqual([{ type: 'text', to: 'band-channel', payload: 'song-handled:list' }]);
  });

  it('does not route to handleSongCommand when BAND_FEATURES_ENABLED is false, falling through to the AI', async () => {
    const { songMock, getResponseMock } = setupMocks(false);
    const { processGroupMessage } = await import('../src/core/process-group-message.js');

    const calls: Array<{ type: string; to: string; payload: unknown }> = [];
    const messenger = makeMessenger(calls);

    await processGroupMessage({
      messenger,
      chatId: 'band-channel',
      senderId: OWNER_ID,
      groupName: 'Band',
      ownerId: 'owner-dm-channel',
      ownerUserId: OWNER_ID,
      query: '!song list',
      isFeatureEnabled: () => true,
      getResponse: getResponseMock,
    });

    expect(songMock).not.toHaveBeenCalled();
    expect(getResponseMock).toHaveBeenCalledWith(
      '!song list',
      expect.objectContaining({ groupJid: 'band-channel', senderJid: OWNER_ID }),
      expect.any(Function),
      undefined,
    );
    expect(calls).toEqual([{ type: 'text', to: 'band-channel', payload: 'ai response' }]);
  });

  it('declines and does not call handleSongCommand for a non-owner sender when the flag is on', async () => {
    const { songMock, getResponseMock } = setupMocks(true);
    const { processGroupMessage } = await import('../src/core/process-group-message.js');

    const calls: Array<{ type: string; to: string; payload: unknown }> = [];
    const messenger = makeMessenger(calls);

    await processGroupMessage({
      messenger,
      chatId: 'band-channel',
      senderId: BAND_MEMBER_ID,
      groupName: 'Band',
      ownerId: 'owner-dm-channel',
      ownerUserId: OWNER_ID,
      query: '!song list',
      isFeatureEnabled: () => true,
      getResponse: getResponseMock,
    });

    expect(songMock).not.toHaveBeenCalled();
    expect(getResponseMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe('band-channel');
    expect(String(calls[0]?.payload)).toMatch(/owner|band/i);
  });

  it('routes !song to handleSongCommand for a non-owner band member when the flag is on', async () => {
    const { songMock, getResponseMock } = setupMocks(true);
    const { processGroupMessage } = await import('../src/core/process-group-message.js');

    const calls: Array<{ type: string; to: string; payload: unknown }> = [];
    const messenger = makeMessenger(calls);

    await processGroupMessage({
      messenger,
      chatId: 'band-channel',
      senderId: BAND_MEMBER_ID,
      groupName: 'Band',
      ownerId: 'owner-dm-channel',
      ownerUserId: OWNER_ID,
      senderIsBandMember: true,
      query: '!song list',
      isFeatureEnabled: () => true,
      getResponse: getResponseMock,
    });

    expect(songMock).toHaveBeenCalledWith('list');
    expect(getResponseMock).not.toHaveBeenCalled();
    expect(calls).toEqual([{ type: 'text', to: 'band-channel', payload: 'song-handled:list' }]);
  });

  it('falls back to owner-comparable ownerId when ownerUserId is not provided (WhatsApp-style callers)', async () => {
    const { songMock } = setupMocks(true);
    const { processGroupMessage } = await import('../src/core/process-group-message.js');

    const calls: Array<{ type: string; to: string; payload: unknown }> = [];
    const messenger = makeMessenger(calls);

    await processGroupMessage({
      messenger,
      chatId: 'wa-group@g.us',
      senderId: OWNER_ID,
      groupName: 'General',
      ownerId: OWNER_ID,
      // ownerUserId omitted — mirrors WhatsApp callers where ownerId IS the
      // owner's comparable JID.
      query: '!song list',
      isFeatureEnabled: () => true,
      getResponse: vi.fn(async () => 'ai response'),
    });

    expect(songMock).toHaveBeenCalledWith('list');
  });
});
