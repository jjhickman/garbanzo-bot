import { beforeEach, describe, expect, it, vi } from 'vitest';

function setupMocks() {
  const isFeatureEnabled = vi.fn((_jid: string, feature: string) => feature !== 'poll');

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
      OWNER_JID: 'owner@s.whatsapp.net',
      MESSAGING_PLATFORM: 'whatsapp',
      DB_DIALECT: 'sqlite',
    },
  }));

  vi.doMock('../src/bot/groups.js', () => ({
    GROUP_IDS: {
      'intro@g.us': { name: 'Introductions', enabled: true },
      'events@g.us': { name: 'Events', enabled: true },
      'group@g.us': { name: 'General', enabled: true },
      'group-legacy@g.us': { name: 'General Legacy', enabled: true },
      'group-core@g.us': { name: 'General Core', enabled: true },
    },
    requiresMention: vi.fn(() => true),
    isMentioned: vi.fn(() => true),
    stripMention: vi.fn((t: string) => t),
    getGroupName: vi.fn(() => 'General'),
    isFeatureEnabled,
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

  // Feedback DB writes
  vi.doMock('../src/utils/db.js', () => ({
    submitFeedback: vi.fn(() => ({ id: 7, sender: 'user@s.whatsapp.net' })),
    getFeedbackById: vi.fn(() => null),
    upvoteFeedback: vi.fn(() => true),
    touchProfile: vi.fn(),
    updateActiveGroups: vi.fn(),
    logModeration: vi.fn(),
    formatMemoriesForPrompt: vi.fn(() => ''),
  }));

  // Poll dedup state is in-memory; no mock required.

  // Character/voice/media not exercised in these parity tests
  vi.doMock('../src/features/character.js', () => ({
    handleCharacter: vi.fn(async () => 'character not used'),
  }));
  vi.doMock('../src/features/voice.js', () => ({
    handleVoiceCommand: vi.fn(() => ({ action: 'list' })),
    formatVoiceList: vi.fn(() => ''),
    textToSpeech: vi.fn(async () => null),
    isTTSAvailable: vi.fn(() => false),
    transcribeAudio: vi.fn(async () => null),
  }));
  vi.doMock('../src/features/media.js', () => ({
    extractMedia: vi.fn(async () => null),
    prepareForVision: vi.fn(async () => []),
  }));

  vi.doMock('../src/bot/response-router.js', () => ({
    getResponse: vi.fn(async () => 'ai response'),
  }));

  return { isFeatureEnabled };
}

describe('Core group processor parity (WhatsApp)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('poll command sends equivalent poll payload', async () => {
    const { isFeatureEnabled } = setupMocks();
    isFeatureEnabled.mockImplementation((_jid: string, feature: string) => feature === 'poll');

    const { handleGroupMessage } = await import('../src/bot/group-handler.js');
    const { processGroupMessage } = await import('../src/core/process-group-message.js');

    const legacyCalls: Array<{ to: string; content: any }> = [];
    const sock: any = {
      user: { id: 'bot@s.whatsapp.net', lid: 'bot@lid' },
      sendMessage: vi.fn(async (to: string, content: any) => {
        legacyCalls.push({ to, content });
        return { key: { id: 'sent1', remoteJid: to } };
      }),
    };

    const msg: any = { key: { id: 'm1' } };
    await handleGroupMessage(sock, msg, 'group-legacy@g.us', 'user@s.whatsapp.net', '!poll What day? / Fri / Sat', undefined, false);

    const coreCalls: Array<{ type: string; to: string; payload: any }> = [];
    const messenger: any = {
      platform: 'whatsapp',
      sendText: vi.fn(async (to: string, text: string) => coreCalls.push({ type: 'text', to, payload: text })),
      sendTextWithRef: vi.fn(async (to: string, text: string) => {
        coreCalls.push({ type: 'textRef', to, payload: text });
        return { key: { id: 'sent2', remoteJid: to } };
      }),
      sendPoll: vi.fn(async (to: string, poll: any) => coreCalls.push({ type: 'poll', to, payload: poll })),
      sendDocument: vi.fn(async () => ({ key: { id: 'doc1' } })),
      sendAudio: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
    };

    await processGroupMessage({
      messenger,
      chatId: 'group-core@g.us',
      senderId: 'user@s.whatsapp.net',
      groupName: 'General',
      query: '!poll What day? / Fri / Sat',
      replyTo: msg,
    });

    const legacyPoll = legacyCalls.find((c) => c.to === 'group-legacy@g.us' && c.content?.poll)?.content?.poll;
    const corePoll = coreCalls.find((c) => c.type === 'poll' && c.to === 'group-core@g.us')?.payload;

    expect(legacyPoll).toBeTruthy();
    expect(corePoll).toBeTruthy();
    expect(corePoll).toEqual(legacyPoll);
  });

  it('suggest command sends equivalent group response and owner DM', async () => {
    setupMocks();

    const { handleGroupMessage } = await import('../src/bot/group-handler.js');
    const { processGroupMessage } = await import('../src/core/process-group-message.js');

    const legacyCalls: Array<{ to: string; content: any }> = [];
    const sock: any = {
      user: { id: 'bot@s.whatsapp.net', lid: 'bot@lid' },
      sendMessage: vi.fn(async (to: string, content: any) => {
        legacyCalls.push({ to, content });
        return { key: { id: 'sent1', remoteJid: to } };
      }),
    };

    const msg: any = { key: { id: 'm2' } };
    const text = '!suggest Add a better onboarding guide to the README please';
    await handleGroupMessage(sock, msg, 'group@g.us', 'user@s.whatsapp.net', text, undefined, false);

    const coreCalls: Array<{ type: string; to: string; payload: any }> = [];
    const messenger: any = {
      platform: 'whatsapp',
      sendText: vi.fn(async (to: string, t: string) => coreCalls.push({ type: 'text', to, payload: t })),
      sendTextWithRef: vi.fn(async (to: string, t: string) => {
        coreCalls.push({ type: 'textRef', to, payload: t });
        return { key: { id: 'sent2', remoteJid: to } };
      }),
      sendPoll: vi.fn(async (to: string, poll: any) => coreCalls.push({ type: 'poll', to, payload: poll })),
      sendDocument: vi.fn(async () => ({ key: { id: 'doc1' } })),
      sendAudio: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
    };

    await processGroupMessage({
      messenger,
      chatId: 'group@g.us',
      senderId: 'user@s.whatsapp.net',
      groupName: 'General',
      query: text,
      replyTo: msg,
    });

    const legacyGroupText = legacyCalls.find((c) => c.to === 'group@g.us')?.content?.text;
    const legacyOwnerText = legacyCalls.find((c) => c.to === 'owner@s.whatsapp.net')?.content?.text;

    const coreGroupText = coreCalls.find((c) => c.to === 'group@g.us')?.payload;
    const coreOwnerText = coreCalls.find((c) => c.to === 'owner@s.whatsapp.net')?.payload;

    expect(legacyGroupText).toBeTruthy();
    expect(coreGroupText).toBeTruthy();
    expect(coreGroupText).toEqual(legacyGroupText);

    expect(legacyOwnerText).toBeTruthy();
    expect(coreOwnerText).toBeTruthy();
    expect(coreOwnerText).toEqual(legacyOwnerText);
  });
});
