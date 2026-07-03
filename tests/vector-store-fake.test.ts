import { describe, expect, it } from 'vitest';
import { createInMemoryVectorStore, type VectorPoint } from '../src/utils/vector-store.js';

function pt(id: string, vector: number[], over: Partial<VectorPoint['payload']> = {}): VectorPoint {
  return {
    id,
    vector,
    payload: { kind: 'message', scope: 'chat', chatJid: 'g1', refId: id, text: id, createdAt: 0, ...over },
  };
}

describe('in-memory vector store', () => {
  it('ranks by cosine similarity and honors limit', async () => {
    const store = createInMemoryVectorStore();
    await store.ensureCollection();
    await store.upsert([pt('a', [1, 0]), pt('b', [0, 1]), pt('c', [0.9, 0.1])]);
    const hits = await store.search([1, 0], { limit: 2 });
    expect(hits.map((h) => h.id)).toEqual(['a', 'c']);
  });

  it('filters by kind, scope, and chatJid', async () => {
    const store = createInMemoryVectorStore();
    await store.upsert([
      pt('m', [1, 0], { kind: 'message', chatJid: 'g1' }),
      pt('f', [1, 0], { kind: 'fact', scope: 'global', chatJid: null }),
    ]);
    const facts = await store.search([1, 0], { limit: 5, filter: { kind: 'fact', scope: 'global' } });
    expect(facts.map((h) => h.id)).toEqual(['f']);
    const g1 = await store.search([1, 0], { limit: 5, filter: { chatJid: 'g1' } });
    expect(g1.map((h) => h.id)).toEqual(['m']);
  });

  it('filters explicit null chatJid to global payloads only', async () => {
    const store = createInMemoryVectorStore();
    await store.upsert([
      pt('global', [1, 0], { kind: 'fact', scope: 'global', chatJid: null }),
      pt('chat', [1, 0], { kind: 'message', scope: 'chat', chatJid: 'g1' }),
    ]);

    const hits = await store.search([1, 0], { limit: 5, filter: { chatJid: null } });

    expect(hits.map((h) => h.id)).toEqual(['global']);
  });

  it('filters by refId', async () => {
    const store = createInMemoryVectorStore();
    await store.upsert([
      pt('a', [1, 0], { refId: 'same-vector-a' }),
      pt('b', [1, 0], { refId: 'same-vector-b' }),
    ]);

    const hits = await store.search([1, 0], { limit: 5, filter: { refId: 'same-vector-b' } });

    expect(hits.map((h) => h.id)).toEqual(['b']);
  });

  it('upsert overwrites by id and delete removes by filter', async () => {
    const store = createInMemoryVectorStore();
    await store.upsert([pt('a', [1, 0])]);
    await store.upsert([pt('a', [0, 1])]);
    expect((await store.search([0, 1], { limit: 1 }))[0].id).toBe('a');
    const removed = await store.delete({ chatJid: 'g1' });
    expect(removed).toBe(1);
    expect(await store.search([0, 1], { limit: 1 })).toEqual([]);
  });

  it('reports healthy', async () => {
    expect((await createInMemoryVectorStore().health()).ok).toBe(true);
  });
});
