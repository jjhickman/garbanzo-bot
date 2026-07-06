process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbBackend } from '../src/utils/db-backend.js';
import type { MemoryEntry } from '../src/utils/db-types.js';
import type { VectorHit, VectorStore } from '../src/utils/vector-store.js';

const sharedHit: VectorHit = {
  id: 'fact:discord:42',
  score: 0.91,
  payload: {
    kind: 'fact',
    scope: 'global',
    chatJid: null,
    refId: 'discord:42',
    text: 'Shared fact from the Discord instance',
    createdAt: 100,
    extra: { originInstance: 'discord', category: 'general' },
  },
};

function makeStore(overrides: Partial<VectorStore> = {}): VectorStore {
  return {
    ensureCollection: vi.fn(async () => undefined),
    upsert: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    delete: vi.fn(async () => 0),
    health: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function makeBackend(memories: MemoryEntry[] = []): DbBackend {
  const backend = {
    addMemory: vi.fn(async (fact: string, category = 'general', source = 'owner') => ({
      id: 1,
      fact,
      category,
      source,
      created_at: 0,
    })),
    getAllMemories: vi.fn(async () => memories),
    deleteMemory: vi.fn(async () => true),
    searchMemory: vi.fn(async () => memories),
    formatMemoriesForPrompt: vi.fn(async () => ''),
    closeDb: vi.fn(async () => undefined),
  };

  return new Proxy(backend, {
    get(target, prop: string | symbol) {
      if (prop === 'then') return undefined;
      if (prop in target) return target[prop as keyof typeof target];
      return vi.fn(async () => undefined);
    },
  }) as unknown as DbBackend;
}

async function loadVectorMemory(options: {
  sharedEnabled: boolean;
  instanceId?: string;
  store?: VectorStore;
}) {
  vi.resetModules();
  process.env.VECTOR_STORE = 'qdrant';
  process.env.INSTANCE_ID = options.instanceId ?? 'remy';
  process.env.SHARED_MEMORY_ENABLED = options.sharedEnabled ? 'true' : 'false';
  process.env.QDRANT_SHARED_COLLECTION = 'shared_test';

  vi.doMock('../src/utils/embedding-provider.js', () => ({
    embedTextForVectorSearch: vi.fn(async () => ({
      vector: [1, 0],
      provider: 'deterministic',
      model: 'test',
      latencyMs: 0,
      usedFallback: false,
    })),
  }));

  const createQdrantVectorStore = vi.fn(() => options.store ?? makeStore());
  vi.doMock('../src/utils/qdrant-store.js', () => ({ createQdrantVectorStore }));

  const mod = await import('../src/utils/vector-memory.js');
  return { mod, createQdrantVectorStore };
}

describe('shared vector memory', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.INSTANCE_ID;
    delete process.env.SHARED_MEMORY_ENABLED;
    delete process.env.QDRANT_SHARED_COLLECTION;
    process.env.VECTOR_STORE = 'none';
  });

  it('indexes shared facts with instance-namespaced refIds', async () => {
    const store = makeStore();
    const { mod, createQdrantVectorStore } = await loadVectorMemory({ sharedEnabled: true, store });

    await expect(mod.indexSharedFact({ localId: 42, text: 'Practice is Sundays', category: 'events' }))
      .resolves.toBe(true);

    expect(createQdrantVectorStore).toHaveBeenCalledWith({ collection: 'shared_test' });
    expect(store.upsert).toHaveBeenCalledWith([
      expect.objectContaining({
        payload: expect.objectContaining({
          refId: 'remy:42',
          extra: { originInstance: 'remy', category: 'events' },
        }),
      }),
    ]);
  });

  it('deletes shared facts by namespaced refId only', async () => {
    const store = makeStore();
    const { mod } = await loadVectorMemory({ sharedEnabled: true, instanceId: 'garbanzo', store });

    await expect(mod.deleteSharedFact(42)).resolves.toBe(true);

    expect(store.delete).toHaveBeenCalledWith({ kind: 'fact', refId: 'garbanzo:42' });
  });

  it('returns shared search hits with origin instance metadata', async () => {
    const store = makeStore({ search: vi.fn(async () => [sharedHit]) });
    const { mod } = await loadVectorMemory({ sharedEnabled: true, store });

    await expect(mod.searchSharedFacts('practice', 4)).resolves.toEqual([
      {
        refId: 'discord:42',
        text: 'Shared fact from the Discord instance',
        score: 0.91,
        originInstance: 'discord',
        category: 'general',
      },
    ]);
  });

  it('is inert and constructs no shared store when the flag is off', async () => {
    const { mod, createQdrantVectorStore } = await loadVectorMemory({ sharedEnabled: false });

    await expect(mod.indexSharedFact({ localId: 1, text: 'No-op', category: 'general' }))
      .resolves.toBe(false);
    await expect(mod.deleteSharedFact(1)).resolves.toBe(false);
    await expect(mod.searchSharedFacts('No-op')).resolves.toEqual([]);
    expect(createQdrantVectorStore).not.toHaveBeenCalled();
  });
});

describe('shared memory search and owner commands', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.INSTANCE_ID;
    delete process.env.SHARED_MEMORY_ENABLED;
    process.env.VECTOR_STORE = 'none';
  });

  it('merges shared hits after local hits without numeric ids', async () => {
    vi.resetModules();
    process.env.SHARED_MEMORY_ENABLED = 'true';
    const local = [{ id: 7, fact: 'Local fact', category: 'venues', source: 'owner', created_at: 50 }];
    vi.doMock('../src/utils/db-sqlite.js', () => ({ createSqliteBackend: () => makeBackend(local) }));
    vi.doMock('../src/utils/vector-memory.js', () => ({
      indexFact: vi.fn(async () => undefined),
      deleteFact: vi.fn(async () => undefined),
      searchFacts: vi.fn(async () => []),
      searchSharedFacts: vi.fn(async () => [{
        refId: 'discord:42',
        text: 'Shared fact from the Discord instance',
        score: 0.91,
        originInstance: 'discord',
        category: 'general',
      }]),
    }));

    const db = await import('../src/utils/db.js');
    const results = await db.searchMemory('fact', 5);

    expect(results[0]).toMatchObject({ id: 7, fact: 'Local fact' });
    expect(results[1]).toEqual({
      shared: true,
      originInstance: 'discord',
      fact: 'Shared fact from the Discord instance',
      category: 'general',
      source: 'shared',
      created_at: 0,
    });
    expect('id' in results[1]).toBe(false);
  });

  it('labels shared search results without exposing the local numeric id', async () => {
    vi.resetModules();
    vi.doMock('../src/utils/db.js', () => ({
      getAllMemories: vi.fn(async () => []),
      addMemory: vi.fn(async () => undefined),
      deleteMemory: vi.fn(async () => false),
      searchMemory: vi.fn(async () => [{
        shared: true,
        originInstance: 'discord',
        fact: 'Shared fact from the Discord instance',
        category: 'general',
        source: 'shared',
        created_at: 0,
      }]),
    }));
    vi.doMock('../src/utils/vector-memory.js', () => ({
      indexSharedFact: vi.fn(async () => true),
      deleteSharedFact: vi.fn(async () => true),
    }));

    const { handleMemory } = await import('../src/features/memory.js');
    const response = await handleMemory('search fact');

    expect(response).toContain('(shared from discord)');
    expect(response).not.toContain('#42');
  });

  it('gates share commands when shared memory is disabled', async () => {
    vi.resetModules();
    process.env.SHARED_MEMORY_ENABLED = 'false';
    const indexSharedFact = vi.fn(async () => true);
    vi.doMock('../src/utils/db.js', () => ({
      getAllMemories: vi.fn(async () => [{ id: 1, fact: 'Local fact', category: 'general', source: 'owner', created_at: 0 }]),
      addMemory: vi.fn(async () => undefined),
      deleteMemory: vi.fn(async () => false),
      searchMemory: vi.fn(async () => []),
    }));
    vi.doMock('../src/utils/vector-memory.js', () => ({
      indexSharedFact,
      deleteSharedFact: vi.fn(async () => true),
    }));

    const { handleMemory } = await import('../src/features/memory.js');
    const response = await handleMemory('share 1');

    expect(response).toContain('Shared memory is disabled');
    expect(indexSharedFact).not.toHaveBeenCalled();
  });
});
