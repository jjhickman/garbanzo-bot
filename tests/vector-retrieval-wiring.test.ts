process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchMessages = vi.fn(async () => [
  {
    id: 'm1',
    score: 0.9,
    payload: {
      kind: 'message' as const,
      scope: 'chat' as const,
      chatJid: 'g1',
      refId: '100:s1',
      text: 'red line is delayed',
      createdAt: 100,
      extra: { sender: 's1' },
    },
  },
]);

const searchSessions = vi.fn(async () => [
  {
    id: 's1',
    score: 0.8,
    payload: {
      kind: 'session' as const,
      scope: 'chat' as const,
      chatJid: 'g1',
      refId: '42',
      text: 'The group discussed the red line delay and shuttle buses.',
      createdAt: 200,
      extra: {
        topics: ['mbta', 'red line'],
        timeRange: [150, 200],
        messageCount: 4,
        participants: ['s1', 's2'],
      },
    },
  },
]);

const keywordSearch = vi.fn(async () => []);
const keywordSessionSearch = vi.fn(async () => []);

async function loadContext() {
  vi.resetModules();
  vi.doMock('../src/utils/vector-memory.js', () => ({
    indexMessage: vi.fn(),
    indexSession: vi.fn(),
    indexFact: vi.fn(),
    deleteFact: vi.fn(),
    searchMessages,
    searchSessions,
    searchFacts: vi.fn(async () => []),
  }));
  vi.doMock('../src/utils/db.js', async () => ({
    ...(await vi.importActual<Record<string, unknown>>('../src/utils/db.js')),
    storeMessage: vi.fn(async () => {}),
    getMessages: vi.fn(async () => [{ sender: 's9', text: 'hello', timestamp: 999 }]),
    searchRelevantMessages: keywordSearch,
    searchRelevantSessionSummaries: keywordSessionSearch,
  }));
  return import('../src/middleware/context.js');
}

describe('retrieval wiring', () => {
  beforeEach(() => {
    searchMessages.mockClear();
    searchMessages.mockResolvedValue([
      {
        id: 'm1',
        score: 0.9,
        payload: {
          kind: 'message',
          scope: 'chat',
          chatJid: 'g1',
          refId: '100:s1',
          text: 'red line is delayed',
          createdAt: 100,
          extra: { sender: 's1' },
        },
      },
    ]);
    searchSessions.mockClear();
    searchSessions.mockResolvedValue([
      {
        id: 's1',
        score: 0.8,
        payload: {
          kind: 'session',
          scope: 'chat',
          chatJid: 'g1',
          refId: '42',
          text: 'The group discussed the red line delay and shuttle buses.',
          createdAt: 200,
          extra: {
            topics: ['mbta', 'red line'],
            timeRange: [150, 200],
            messageCount: 4,
            participants: ['s1', 's2'],
          },
        },
      },
    ]);
    keywordSearch.mockClear();
    keywordSessionSearch.mockClear();
  });

  it('uses vector hits and does not fall back to keyword when vectors return', async () => {
    const ctx = await loadContext();
    const out = await ctx.formatContext('g1', 'is the red line delayed');
    expect(searchMessages).toHaveBeenCalled();
    expect(searchSessions).toHaveBeenCalled();
    expect(out).toContain('red line is delayed');
    expect(out).toContain('The group discussed the red line delay and shuttle buses.');
    expect(keywordSearch).not.toHaveBeenCalled();
    expect(keywordSessionSearch).not.toHaveBeenCalled();
  });

  it('falls back to keyword search when vector search returns empty', async () => {
    searchMessages.mockResolvedValueOnce([]);
    searchSessions.mockResolvedValueOnce([]);
    const ctx = await loadContext();
    await ctx.formatContext('g1', 'is the red line delayed');
    expect(keywordSearch).toHaveBeenCalled();
    expect(keywordSessionSearch).toHaveBeenCalled();
  });
});
