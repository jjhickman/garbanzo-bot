process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const indexMessage = vi.fn(async () => {});

async function loadContext() {
  vi.resetModules();
  vi.doMock('../src/utils/vector-memory.js', () => ({
    indexMessage, indexSession: vi.fn(), indexFact: vi.fn(), deleteFact: vi.fn(),
    searchMessages: vi.fn(async () => []), searchSessions: vi.fn(async () => []), searchFacts: vi.fn(async () => []),
  }));
  vi.doMock('../src/utils/db.js', async () => ({
    ...(await vi.importActual<Record<string, unknown>>('../src/utils/db.js')),
    storeMessage: vi.fn(async () => 1_700_000_000),
    getMessages: vi.fn(async () => []),
    searchRelevantMessages: vi.fn(async () => []),
    searchRelevantSessionSummaries: vi.fn(async () => []),
  }));
  return import('../src/middleware/context.js');
}

describe('ingest wiring', () => {
  beforeEach(() => {
    indexMessage.mockReset();
    indexMessage.mockResolvedValue(undefined);
  });

  it('indexes a message vector after recording it', async () => {
    const ctx = await loadContext();
    await ctx.recordMessage('g1@g.us', 's1@s.whatsapp.net', 'is it raining today');
    expect(indexMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatJid: 'g1@g.us',
      refId: '1700000000:s1',
      sender: 's1',
      text: 'is it raining today',
    }));
  });

  it('does not reject recordMessage when message vector indexing rejects', async () => {
    indexMessage.mockRejectedValueOnce(new Error('qdrant down'));
    const ctx = await loadContext();
    await expect(ctx.recordMessage('g1@g.us', 's1@s.whatsapp.net', 'is it raining today')).resolves.toBeUndefined();
  });
});
