import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('release notes helper', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function mockReleaseDeps() {
    vi.doMock('../src/bot/groups.js', () => ({
      GROUP_IDS: {
        'general@g.us': { name: 'General', enabled: true },
        'events@g.us': { name: 'Events', enabled: true },
      },
    }));

    vi.doMock('../src/middleware/logger.js', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }));
  }

  it('shows changelog usage in help text', async () => {
    mockReleaseDeps();
    const { handleRelease } = await import('../src/features/release.js');
    const sock = { sendMessage: vi.fn(async () => undefined) };

    const result = await handleRelease('', sock as never);
    expect(result).toContain('!release changelog');
  });

  it('broadcasts changelog snippet to all enabled groups', async () => {
    mockReleaseDeps();
    const { handleRelease } = await import('../src/features/release.js');
    const sock = { sendMessage: vi.fn(async () => undefined) };

    const result = await handleRelease('changelog', sock as never);
    expect(result).toContain('Release notes sent to 2 groups');

    const calls = sock.sendMessage.mock.calls as unknown as Array<[string, { text?: string }]>;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]?.text).toContain('What\'s New with Garbanzo');
    expect(calls[0]?.[1]?.text).toContain('Changelog');
  });

  it('sends changelog snippet to one target group', async () => {
    mockReleaseDeps();
    const { handleRelease } = await import('../src/features/release.js');
    const sock = { sendMessage: vi.fn(async () => undefined) };

    const result = await handleRelease('general changelog', sock as never);
    expect(result).toContain('Release notes sent to 1 group');

    const calls = sock.sendMessage.mock.calls as unknown as Array<[string, { text?: string }]>;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('general@g.us');
  });
});
