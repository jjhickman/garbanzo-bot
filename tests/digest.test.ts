import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('daily digest formatting', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function mockDigestDeps(fallbackRows: Array<{ chatJid: string; messageCount: number; activeUsers: number }>) {
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    }));

    vi.doMock('../src/middleware/stats.js', () => ({
      getCurrentStats: vi.fn(),
    }));

    vi.doMock('../src/core/groups-config.js', () => ({
      getGroupName: (jid: string) => {
        if (jid === 'bookclub@g.us') return 'Book Club';
        if (jid === 'general@g.us') return 'General';
        return 'Unknown Group';
      },
    }));

    vi.doMock('../src/utils/db.js', () => ({
      saveDailyStats: vi.fn(),
      getDailyGroupActivity: vi.fn(() => fallbackRows),
    }));
  }

  it('falls back to persisted message logs when in-memory stats are empty', async () => {
    mockDigestDeps([
      { chatJid: 'bookclub@g.us', messageCount: 17, activeUsers: 6 },
      { chatJid: 'general@g.us', messageCount: 4, activeUsers: 3 },
    ]);

    const { formatDigest } = await import('../src/features/digest.js');

    const out = await formatDigest({
      date: '2026-02-16',
      groups: new Map(),
      ownerDMs: 0,
      costs: [],
      totalCost: 0,
    });

    expect(out).toContain('Book Club');
    expect(out).toContain('17 msgs, 6 active users');
    expect(out).toContain('21 messages across 2 groups');
    expect(out).toContain('Recovered from persisted message logs');
  });

  it('shows no activity when both in-memory and fallback stats are empty', async () => {
    mockDigestDeps([]);

    const { formatDigest } = await import('../src/features/digest.js');

    const out = await formatDigest({
      date: '2026-02-16',
      groups: new Map(),
      ownerDMs: 0,
      costs: [],
      totalCost: 0,
    });

    expect(out).toContain('No group activity recorded today');
    expect(out).toContain('0 messages across 0 groups');
  });
});
