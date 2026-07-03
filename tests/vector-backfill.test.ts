process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const indexFact = vi.fn(async () => {});
const indexMessage = vi.fn(async () => {});
const indexSession = vi.fn(async () => {});
const getAllMemories = vi.fn(async () => [
  { id: 1, fact: 'Founded in 2024', category: 'general', source: 'owner', created_at: 10 },
  { id: 2, fact: 'Trivia Wednesdays', category: 'venues', source: 'owner', created_at: 20 },
]);
const getMessages = vi.fn(async () => []);
const listAllSessionSummaries = vi.fn(async () => []);

async function loadBackfill() {
  vi.resetModules();
  vi.doMock('../src/core/groups-config.js', () => ({
    GROUP_IDS: {
      'g1@g.us': { name: 'General', enabled: true, requireMention: true },
    },
  }));
  vi.doMock('../src/utils/vector-memory.js', () => ({
    indexFact,
    indexMessage,
    indexSession,
  }));
  vi.doMock('../src/utils/db.js', async () => ({
    ...(await vi.importActual<Record<string, unknown>>('../src/utils/db.js')),
    getAllMemories,
    getMessages,
    listAllSessionSummaries,
  }));
  return import('../src/utils/vector-backfill.js');
}

describe('vector backfill', () => {
  beforeEach(() => {
    indexFact.mockClear();
    indexMessage.mockClear();
    indexSession.mockClear();
    getAllMemories.mockReset();
    getAllMemories.mockResolvedValue([
      { id: 1, fact: 'Founded in 2024', category: 'general', source: 'owner', created_at: 10 },
      { id: 2, fact: 'Trivia Wednesdays', category: 'venues', source: 'owner', created_at: 20 },
    ]);
    getMessages.mockReset();
    getMessages.mockResolvedValue([]);
    listAllSessionSummaries.mockReset();
    listAllSessionSummaries.mockResolvedValue([]);
  });

  it('re-indexes all facts and reports progress', async () => {
    const mod = await loadBackfill();
    const progress = await mod.backfillVectors({ batchSize: 1, batchDelayMs: 0 });
    expect(indexFact).toHaveBeenCalledTimes(2);
    expect(progress.succeeded).toBe(2);
    expect(progress.failed).toBe(0);
  });

  it('reuses stored message timestamp and sender for message refIds', async () => {
    getAllMemories.mockResolvedValue([]);
    getMessages.mockResolvedValue([
      { timestamp: 1_700_000_123, sender: 'sender-bare', text: 'stored text' },
    ]);

    const mod = await loadBackfill();
    const progress = await mod.backfillVectors({ batchSize: 10, batchDelayMs: 0 });

    expect(indexMessage).toHaveBeenCalledWith({
      chatJid: 'g1@g.us',
      refId: '1700000123:sender-bare',
      sender: 'sender-bare',
      text: 'stored text',
      createdAt: 1_700_000_123,
    });
    expect(progress.succeeded).toBe(1);
  });

  it('indexes listed sessions with stable session refIds', async () => {
    getAllMemories.mockResolvedValue([]);
    listAllSessionSummaries.mockResolvedValue([
      {
        sessionId: 42,
        chatJid: 'g1@g.us',
        startedAt: 100,
        endedAt: 200,
        messageCount: 3,
        participants: ['a', 'b'],
        topicTags: ['trivia'],
        summaryText: 'Discussed trivia plans in Cambridge.',
      },
    ]);

    const mod = await loadBackfill();
    const progress = await mod.backfillVectors({ batchSize: 10, batchDelayMs: 0 });

    expect(indexSession).toHaveBeenCalledWith(expect.objectContaining({
      chatJid: 'g1@g.us',
      refId: '42',
      summaryText: 'Discussed trivia plans in Cambridge.',
      createdAt: 200,
    }));
    expect(progress.succeeded).toBe(1);
  });
});
