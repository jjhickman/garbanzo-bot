process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryVectorStore, type VectorStore } from '../src/utils/vector-store.js';
import type { EmbeddingResult } from '../src/utils/embedding-provider.js';

type EmbedMock = (text: string, dimensions: number) => Promise<EmbeddingResult>;

const defaultEmbedMock: EmbedMock = async (text: string) => ({
  vector: text.includes('weather') ? [1, 0] : [0, 1],
  provider: 'deterministic',
  model: 'test',
  latencyMs: 0,
  usedFallback: false,
});

function mockEmbedding(embedMock: EmbedMock): void {
  vi.doMock('../src/utils/embedding-provider.js', () => ({
    embedTextForVectorSearch: vi.fn(embedMock),
  }));
}

async function loadModule(embedMock: EmbedMock = defaultEmbedMock) {
  vi.resetModules();
  mockEmbedding(embedMock);
  return import('../src/utils/vector-memory.js');
}

async function loadModuleWithStats(embedMock: EmbedMock) {
  vi.resetModules();
  mockEmbedding(embedMock);
  const stats = await import('../src/middleware/stats.js');
  const recordVectorUpsert = vi.spyOn(stats, 'recordVectorUpsert');
  const recordVectorSearch = vi.spyOn(stats, 'recordVectorSearch');
  const mod = await import('../src/utils/vector-memory.js');
  return { mod, recordVectorUpsert, recordVectorSearch };
}

async function loadModuleWithStoreFactory(store: VectorStore) {
  vi.resetModules();
  mockEmbedding(defaultEmbedMock);
  vi.doMock('../src/utils/qdrant-store.js', () => ({
    createQdrantVectorStore: () => store,
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

  it('deleteFact removes only the matching fact', async () => {
    const mod = await loadModule();
    const store = createInMemoryVectorStore();
    mod.__setVectorStoreForTests(store);

    await mod.indexFact({
      refId: '1',
      text: 'weather is nice',
      category: 'general',
      createdAt: 0,
    });
    await mod.indexFact({
      refId: '2',
      text: 'weather is still nice',
      category: 'general',
      createdAt: 1,
    });

    await mod.deleteFact('1');

    const hits = await mod.searchFacts('weather', 3);
    expect(hits.map((h) => h.payload.refId)).toEqual(['2']);
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

  it('skips vector paths and records errors when OpenAI embeddings fall back to deterministic', async () => {
    const fallbackEmbedMock: EmbedMock = async () => ({
      vector: [1, 0],
      provider: 'deterministic',
      model: 'x',
      latencyMs: 0,
      usedFallback: true,
    });
    const { mod, recordVectorUpsert, recordVectorSearch } = await loadModuleWithStats(fallbackEmbedMock);
    const store = createInMemoryVectorStore();
    mod.__setVectorStoreForTests(store);

    await mod.indexFact({
      refId: '1',
      text: 'weather is nice',
      category: 'general',
      createdAt: 0,
    });

    expect(await store.search([1, 0], { limit: 3 })).toEqual([]);
    expect(recordVectorUpsert).toHaveBeenCalledWith('error');

    await expect(mod.searchFacts('weather', 3)).resolves.toEqual([]);
    expect(recordVectorSearch).toHaveBeenCalledWith('error');
  });

  it('degrades when ensureCollection fails and does not retry every operation', async () => {
    const ensureCollection = vi.fn(async () => {
      throw new Error('qdrant down');
    });
    const store: VectorStore = {
      ensureCollection,
      upsert: vi.fn(async () => {}),
      search: vi.fn(async () => []),
      delete: vi.fn(async () => 0),
      health: vi.fn(async () => ({ ok: false })),
    };
    const mod = await loadModuleWithStoreFactory(store);

    await expect(mod.searchFacts('weather', 3)).resolves.toEqual([]);
    await expect(
      mod.indexFact({
        refId: '1',
        text: 'weather is nice',
        category: 'general',
        createdAt: 0,
      }),
    ).resolves.toBeUndefined();
    await expect(mod.searchFacts('weather again', 3)).resolves.toEqual([]);

    expect(ensureCollection).toHaveBeenCalledTimes(1);
  });
});
