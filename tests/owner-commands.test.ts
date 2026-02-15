import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('owner support commands', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function mockOwnerDeps() {
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
    vi.doMock('../src/bot/groups.js', () => ({
      GROUP_IDS: {
        'g1@g.us': { name: 'General', enabled: true },
        'g2@g.us': { name: 'Offtopic', enabled: true },
        'g3@g.us': { name: 'Disabled', enabled: false },
      },
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
});
