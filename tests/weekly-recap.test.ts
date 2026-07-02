process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';

function archivedDay(date: string, groups: Record<string, object>, ownerDMs = 0): { date: string; data: string } {
  return { date, data: JSON.stringify({ date, groups, ownerDMs }) };
}

describe('weekly recap aggregation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function mockDeps(rows: Array<{ date: string; data: string }>, liveGroups: Map<string, unknown> = new Map()) {
    vi.doMock('../src/middleware/logger.js', () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('../src/utils/db.js', () => ({
      loadDailyStatsRange: vi.fn(async () => rows),
    }));
    vi.doMock('../src/middleware/stats.js', () => ({
      getCurrentStats: vi.fn(() => ({ date: '2026-07-02', groups: liveGroups, ownerDMs: 0, costs: [], totalCost: 0 })),
    }));
    vi.doMock('../src/core/groups-config.js', () => ({
      getGroupName: (jid: string) => (jid === 'g1@g.us' ? 'General' : jid),
    }));
  }

  it('aggregates archived days and unions active users', async () => {
    mockDeps([
      archivedDay('2026-06-29', {
        'g1@g.us': { messageCount: 100, activeUsers: ['a', 'b'], botResponses: 5, moderationFlags: 1 },
      }, 2),
      archivedDay('2026-06-30', {
        'g1@g.us': { messageCount: 50, activeUsers: ['b', 'c'], botResponses: 3, moderationFlags: 0 },
      }, 1),
    ]);
    const { buildWeeklyRecap } = await import('../src/features/recap.js');

    const recap = await buildWeeklyRecap(new Date('2026-07-02T12:00:00'));
    expect(recap).toContain('Weekly Recap — 2026-06-26 → 2026-07-02');
    expect(recap).toContain('150 messages from 3 people across 1 group');
    expect(recap).toContain('8 bot replies');
    expect(recap).toContain('3 owner DMs');
    expect(recap).toContain('1 moderation flag');
    expect(recap).toContain('General — 150 msgs, 3 people, 8 replies');
  });

  it('merges live in-memory stats for the unarchived current day', async () => {
    const liveGroups = new Map([[
      'g1@g.us',
      { messageCount: 10, activeUsers: new Set(['z']), botResponses: 1, moderationFlags: 0 },
    ]]);
    mockDeps([
      archivedDay('2026-07-01', {
        'g1@g.us': { messageCount: 5, activeUsers: ['a'], botResponses: 0, moderationFlags: 0 },
      }),
    ], liveGroups as never);
    const { buildWeeklyRecap } = await import('../src/features/recap.js');

    const recap = await buildWeeklyRecap(new Date('2026-07-02T12:00:00'));
    expect(recap).toContain('15 messages from 2 people');
  });

  it('reports no activity gracefully', async () => {
    mockDeps([]);
    const { buildWeeklyRecap } = await import('../src/features/recap.js');
    const recap = await buildWeeklyRecap(new Date('2026-07-02T12:00:00'));
    expect(recap).toContain('No recorded activity this week.');
  });

  it('skips unparseable archive rows instead of failing', async () => {
    mockDeps([
      { date: '2026-06-30', data: 'not-json' },
      archivedDay('2026-07-01', {
        'g1@g.us': { messageCount: 7, activeUsers: ['a'], botResponses: 2, moderationFlags: 0 },
      }),
    ]);
    const { buildWeeklyRecap } = await import('../src/features/recap.js');
    const recap = await buildWeeklyRecap(new Date('2026-07-02T12:00:00'));
    expect(recap).toContain('7 messages');
  });
});

describe('weekly recap scheduling math', () => {
  it('targets the next Sunday 18:00', async () => {
    const { __testing } = await import('../src/platforms/whatsapp/recap.js');
    vi.useFakeTimers();
    try {
      // Thursday 2026-07-02 12:00 local → Sunday 2026-07-05 18:00 = 3d6h
      vi.setSystemTime(new Date('2026-07-02T12:00:00'));
      expect(__testing.msUntilWeekdayHour(0, 18)).toBe(((3 * 24 + 6) * 60 * 60) * 1000);

      // Sunday 19:00 → next Sunday 18:00 = 7d - 1h
      vi.setSystemTime(new Date('2026-07-05T19:00:00'));
      expect(__testing.msUntilWeekdayHour(0, 18)).toBe(((7 * 24 - 1) * 60 * 60) * 1000);

      // Sunday 17:00 → same day 18:00 = 1h
      vi.setSystemTime(new Date('2026-07-05T17:00:00'));
      expect(__testing.msUntilWeekdayHour(0, 18)).toBe(60 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });
});
