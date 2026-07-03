import { describe, expect, it } from 'vitest';
import { createQdrantVectorStore } from '../src/utils/qdrant-store.js';

const RUN = !!process.env.QDRANT_URL;

describe.skipIf(!RUN)('qdrant integration', () => {
  it('round-trips ensureCollection -> upsert -> search -> delete', async () => {
    const store = createQdrantVectorStore();
    await store.ensureCollection();
    const dims = Number(process.env.VECTOR_EMBEDDING_DIMENSIONS ?? 1536);
    const vec = Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0));
    await store.upsert([{
      id: '00000000-0000-5000-8000-000000000001',
      vector: vec,
      payload: {
        kind: 'fact',
        scope: 'global',
        chatJid: null,
        refId: 'itest',
        text: 'integration',
        createdAt: 0,
      },
    }]);
    const hits = await store.search(vec, { limit: 1, filter: { kind: 'fact' } });
    expect(hits[0]?.payload.refId).toBe('itest');
    await store.delete({ kind: 'fact' });
  });
});
