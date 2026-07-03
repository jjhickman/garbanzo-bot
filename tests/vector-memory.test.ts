process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryVectorStore } from '../src/utils/vector-store.js';

async function loadModule() {
  vi.resetModules();
  vi.doMock('../src/utils/embedding-provider.js', () => ({
    embedTextForVectorSearch: vi.fn(async (text: string) => ({
      vector: text.includes('weather') ? [1, 0] : [0, 1],
      provider: 'deterministic',
      model: 'test',
      latencyMs: 0,
      usedFallback: false,
    })),
  }));
  return import('../src/utils/vector-memory.js');
}

describe('vector-memory orchestrator', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('indexes a fact then retrieves it by semantic query', async () => {
    const mod = await loadModule();
    const store = createInMemoryVectorStore();
    mod.__setVectorStoreForTests(store);

    await mod.indexFact({
      refId: '1',
      text: 'weather is nice',
      category: 'general',
      createdAt: 0,
    });

    const hits = await mod.searchFacts('weather', 3);

    expect(hits.map((h) => h.payload.refId)).toEqual(['1']);
  });

  it('scopes message search to the chat and never throws when store is null', async () => {
    const mod = await loadModule();
    mod.__setVectorStoreForTests(null);

    await expect(mod.searchMessages('g1', 'weather', 3)).resolves.toEqual([]);
    await expect(
      mod.indexMessage({
        chatJid: 'g1',
        refId: '1',
        sender: 's',
        text: 't',
        createdAt: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns [] when the store search throws (degradation)', async () => {
    const mod = await loadModule();
    mod.__setVectorStoreForTests({
      ensureCollection: async () => {},
      upsert: async () => {},
      delete: async () => 0,
      health: async () => ({ ok: false }),
      search: async () => {
        throw new Error('qdrant down');
      },
    });

    await expect(mod.searchFacts('weather', 3)).resolves.toEqual([]);
  });
});
