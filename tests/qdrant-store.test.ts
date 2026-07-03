import { describe, expect, it, vi } from 'vitest';
import { buildQdrantFilter, createQdrantVectorStore } from '../src/utils/qdrant-store.js';

describe('buildQdrantFilter', () => {
  it('maps our filter to Qdrant must-conditions', () => {
    expect(buildQdrantFilter({ kind: 'fact', scope: 'global', chatJid: null })).toEqual({
      must: [
        { key: 'kind', match: { value: 'fact' } },
        { key: 'scope', match: { value: 'global' } },
        { key: 'chatJid', match: { value: null } },
      ],
    });
  });

  it('omits undefined fields and returns undefined for empty filter', () => {
    expect(buildQdrantFilter({ kind: 'message' })).toEqual({
      must: [{ key: 'kind', match: { value: 'message' } }],
    });
    expect(buildQdrantFilter(undefined)).toBeUndefined();
  });
});

describe('createQdrantVectorStore', () => {
  it('creates the collection when missing', async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [] }),
      createCollection: vi.fn().mockResolvedValue(true),
      upsert: vi.fn(),
      search: vi.fn(),
      delete: vi.fn(),
    };
    const store = createQdrantVectorStore({ client });
    await store.ensureCollection();
    expect(client.createCollection).toHaveBeenCalledWith(
      'garbanzo_memory',
      expect.objectContaining({
        vectors: expect.objectContaining({ size: 1536, distance: 'Cosine' }),
      }),
    );
  });

  it('upserts points into the configured collection', async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [{ name: 'garbanzo_memory' }] }),
      createCollection: vi.fn(),
      upsert: vi.fn(),
      search: vi.fn(),
      delete: vi.fn(),
    };
    const store = createQdrantVectorStore({ client });
    const payload = {
      kind: 'message' as const,
      scope: 'chat' as const,
      chatJid: 'g1',
      refId: '1',
      text: 'hi',
      createdAt: 5,
    };

    await store.upsert([{ id: 'p1', vector: [1, 0], payload }]);

    expect(client.upsert).toHaveBeenCalledWith(
      'garbanzo_memory',
      expect.objectContaining({
        points: expect.arrayContaining([
          expect.objectContaining({
            id: 'p1',
            vector: [1, 0],
            payload,
          }),
        ]),
      }),
    );
  });

  it('maps Qdrant search results to VectorHit', async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [{ name: 'garbanzo_memory' }] }),
      createCollection: vi.fn(),
      upsert: vi.fn(),
      search: vi.fn().mockResolvedValue([
        {
          id: 'x',
          score: 0.9,
          payload: {
            kind: 'message',
            scope: 'chat',
            chatJid: 'g1',
            refId: '1',
            text: 'hi',
            createdAt: 5,
          },
        },
      ]),
      delete: vi.fn(),
    };
    const store = createQdrantVectorStore({ client });
    const hits = await store.search([1, 0], { limit: 3, filter: { chatJid: 'g1' } });
    expect(hits).toEqual([
      {
        id: 'x',
        score: 0.9,
        payload: {
          kind: 'message',
          scope: 'chat',
          chatJid: 'g1',
          refId: '1',
          text: 'hi',
          createdAt: 5,
        },
      },
    ]);
    expect(client.search).toHaveBeenCalledWith('garbanzo_memory', expect.objectContaining({
      vector: [1, 0],
      limit: 3,
      with_payload: true,
      filter: { must: [{ key: 'chatJid', match: { value: 'g1' } }] },
    }));
  });

  it('deletes by filter and returns the unknown-count contract', async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [{ name: 'garbanzo_memory' }] }),
      createCollection: vi.fn(),
      upsert: vi.fn(),
      search: vi.fn(),
      delete: vi.fn(),
    };
    const store = createQdrantVectorStore({ client });

    const deleted = await store.delete({ kind: 'fact', chatJid: null });

    expect(client.delete).toHaveBeenCalledWith('garbanzo_memory', {
      filter: {
        must: [
          { key: 'kind', match: { value: 'fact' } },
          { key: 'chatJid', match: { value: null } },
        ],
      },
    });
    expect(deleted).toBe(0);
  });

  it('health returns ok:false when the client throws', async () => {
    const client = {
      getCollections: vi.fn().mockRejectedValue(new Error('conn refused')),
      createCollection: vi.fn(),
      upsert: vi.fn(),
      search: vi.fn(),
      delete: vi.fn(),
    };
    const store = createQdrantVectorStore({ client });
    const h = await store.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('conn refused');
  });
});
