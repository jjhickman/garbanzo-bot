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
    const sendText = vi.fn(async () => undefined);

    const result = await handleRelease('', sendText);
    expect(result).toContain('!release changelog');
  });

  it('broadcasts changelog snippet to all enabled groups', async () => {
    mockReleaseDeps();
    const { handleRelease } = await import('../src/features/release.js');
    const sendText = vi.fn(async () => undefined);

    const result = await handleRelease('changelog', sendText);
    expect(result).toContain('Release notes sent to 2 groups');

    const calls = sendText.mock.calls as unknown as Array<[string, string]>;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toContain('What\'s New with Garbanzo');
    expect(calls[0]?.[1]).toContain('Changelog');
  });

  it('sends changelog snippet to one target group', async () => {
    mockReleaseDeps();
    const { handleRelease } = await import('../src/features/release.js');
    const sendText = vi.fn(async () => undefined);

    const result = await handleRelease('general changelog', sendText);
    expect(result).toContain('Release notes sent to 1 group');

    const calls = sendText.mock.calls as unknown as Array<[string, string]>;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('general@g.us');
  });
});
