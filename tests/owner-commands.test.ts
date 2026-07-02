import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('owner support commands', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  type MockSafety = {
    metrics: ReturnType<typeof vi.fn>;
    sendControlText: ReturnType<typeof vi.fn>;
  };

  function mockOwnerDeps(safety?: MockSafety) {
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }));

    vi.doMock('../src/utils/config.js', () => ({
      config: {
        OWNER_JID: 'owner@s.whatsapp.net',
        GITHUB_SPONSORS_URL: 'https://github.com/sponsors/jjhickman',
        PATREON_URL: 'https://patreon.com/garbanzo',
        KOFI_URL: 'https://ko-fi.com/garbanzo',
        SUPPORT_CUSTOM_URL: 'https://garbanzo.bot/support',
        SUPPORT_MESSAGE: 'Support Garbanzo to keep community features improving.',
      },
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
      createGitHubIssueFromFeedback: vi.fn(async (id: number) => `created issue for #${id}`),
    }));
    vi.doMock('../src/features/release.js', () => ({ handleRelease: vi.fn(async () => 'release') }));
    vi.doMock('../src/features/memory.js', () => ({ handleMemory: vi.fn(() => 'memory') }));
    vi.doMock('../src/middleware/stats.js', () => ({ recordOwnerDM: vi.fn() }));
    vi.doMock('../src/core/response-router.js', () => ({ getResponse: vi.fn(async () => 'ai') }));
    vi.doMock('../src/platforms/whatsapp/outbound-safety.js', () => ({ getWhatsAppOutboundSafety: vi.fn(() => safety) }));
    vi.doMock('../src/utils/db.js', () => ({
      listUpcomingEventReminders: vi.fn(async () => [
        {
          id: 42,
          chatJid: 'events@g.us',
          activity: 'trivia night',
          location: 'Tavern',
          eventAt: 1767225600,
          remindAt: 1767218400,
          createdBy: 'sender@s.whatsapp.net',
          status: 'pending',
          createdAt: 1767000000,
        },
      ]),
      cancelEventReminder: vi.fn(async (id: number) => id === 42),
    }));
    vi.doMock('../src/core/groups-config.js', () => ({
      GROUP_IDS: {
        'g1@g.us': { name: 'General', enabled: true },
        'g2@g.us': { name: 'Offtopic', enabled: true },
        'g3@g.us': { name: 'Disabled', enabled: false },
      },
      isFeatureEnabled: vi.fn(() => true),
    }));
  }

  it('returns false for non-owner sender', async () => {
    mockOwnerDeps();
    const { handleOwnerDM } = await import('../src/platforms/whatsapp/owner-commands.js');
    const sock = { sendMessage: vi.fn(async () => undefined) };

    const handled = await handleOwnerDM(sock as never, 'owner@s.whatsapp.net', 'user@s.whatsapp.net', '!support');
    expect(handled).toBe(false);
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it('sends support links on !support', async () => {
    mockOwnerDeps();
    const { handleOwnerDM } = await import('../src/platforms/whatsapp/owner-commands.js');
    const sock = { sendMessage: vi.fn(async () => undefined) };

    const handled = await handleOwnerDM(sock as never, 'owner@s.whatsapp.net', 'owner@s.whatsapp.net', '!support');
    expect(handled).toBe(true);
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    const calls = sock.sendMessage.mock.calls as unknown as Array<[string, { text?: string }]>;
    const sentText = calls[0]?.[1]?.text ?? '';
    expect(sentText).toContain('Support Garbanzo');
    expect(sentText).toContain('github.com/sponsors/jjhickman');
    expect(sentText).toContain('patreon.com/garbanzo');
    expect(sentText).toContain('ko-fi.com/garbanzo');
  });

  it('broadcasts support links to all enabled groups', async () => {
    mockOwnerDeps();
    const { handleOwnerDM } = await import('../src/platforms/whatsapp/owner-commands.js');
    const sock = { sendMessage: vi.fn(async () => undefined) };

    const handled = await handleOwnerDM(sock as never, 'owner@s.whatsapp.net', 'owner@s.whatsapp.net', '!support broadcast');
    expect(handled).toBe(true);
    expect(sock.sendMessage).toHaveBeenCalledTimes(3);

    const targets = sock.sendMessage.mock.calls.map((call: unknown[]) => call[0]);
    expect(targets).toContain('g1@g.us');
    expect(targets).toContain('g2@g.us');
    expect(targets).toContain('owner@s.whatsapp.net');
  });

  it('creates GitHub issue from accepted feedback via owner command', async () => {
    mockOwnerDeps();
    const { handleOwnerDM } = await import('../src/platforms/whatsapp/owner-commands.js');
    const sock = { sendMessage: vi.fn(async () => undefined) };

    const handled = await handleOwnerDM(
      sock as never,
      'owner@s.whatsapp.net',
      'owner@s.whatsapp.net',
      '!feedback issue 42',
    );

    expect(handled).toBe(true);
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    const calls = sock.sendMessage.mock.calls as unknown as Array<[string, { text?: string }]>;
    expect(calls[0]?.[1]?.text).toContain('created issue for #42');
  });

  it('routes WhatsApp safety status through an unqueued owner control response', async () => {
    const safety = {
      metrics: vi.fn(async () => ({
        paused: true,
        risk: 'medium',
        score: 35,
        held: 2,
        pending: 0,
        sentLastHour: 3,
        sentLastDay: 7,
        failedLastHour: 0,
      })),
      sendControlText: vi.fn(async () => undefined),
    };
    mockOwnerDeps(safety);
    const { handleOwnerDM } = await import('../src/platforms/whatsapp/owner-commands.js');
    const sock = { sendMessage: vi.fn(async () => undefined) };

    const handled = await handleOwnerDM(sock as never, 'owner@s.whatsapp.net', 'owner@s.whatsapp.net', '!whatsapp status');

    expect(handled).toBe(true);
    expect(safety.sendControlText).toHaveBeenCalledTimes(1);
    expect(String(safety.sendControlText.mock.calls[0]?.[1])).toContain('Held: 2');
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it('lists upcoming event reminders on !events', async () => {
    mockOwnerDeps();
    const { handleOwnerDM } = await import('../src/platforms/whatsapp/owner-commands.js');
    const sock = { sendMessage: vi.fn(async () => undefined) };

    const handled = await handleOwnerDM(sock as never, 'owner@s.whatsapp.net', 'owner@s.whatsapp.net', '!events');

    expect(handled).toBe(true);
    const calls = sock.sendMessage.mock.calls as unknown as Array<[string, { text?: string }]>;
    expect(calls[0]?.[1]?.text).toContain('#42');
    expect(calls[0]?.[1]?.text).toContain('trivia night');
    expect(calls[0]?.[1]?.text).toContain('!events cancel 42');
  });

  it('cancels an event reminder by id on !events cancel', async () => {
    mockOwnerDeps();
    const db = await import('../src/utils/db.js');
    const { handleOwnerDM } = await import('../src/platforms/whatsapp/owner-commands.js');
    const sock = { sendMessage: vi.fn(async () => undefined) };

    const handled = await handleOwnerDM(sock as never, 'owner@s.whatsapp.net', 'owner@s.whatsapp.net', '!events cancel 42');

    expect(handled).toBe(true);
    expect(db.cancelEventReminder).toHaveBeenCalledWith(42);
    const calls = sock.sendMessage.mock.calls as unknown as Array<[string, { text?: string }]>;
    expect(calls[0]?.[1]?.text).toContain('cancelled');
  });
});
