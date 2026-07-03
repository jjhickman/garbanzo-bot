process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VectorStore } from '../src/utils/vector-store.js';

async function loadHealthModule(): Promise<typeof import('../src/middleware/health.js')> {
  return import('../src/middleware/health.js');
}

describe('health Qdrant status', () => {
  afterEach(async () => {
    const { stopHealthServer } = await loadHealthModule();
    const { __setVectorStoreForTests } = await import('../src/utils/vector-memory.js');
    stopHealthServer();
    __setVectorStoreForTests(null);
    vi.restoreAllMocks();
  });

  it('includes vectorStore.ok in the health payload', async () => {
    const { __setVectorStoreForTests } = await import('../src/utils/vector-memory.js');
    const store: VectorStore = {
      ensureCollection: async () => {},
      upsert: async () => {},
      search: async () => [],
      delete: async () => 0,
      health: async () => ({ ok: true }),
    };
    __setVectorStoreForTests(store);

    const { __testing } = await loadHealthModule();
    const payload = await __testing.buildHealthPayload(Date.now());

    expect(payload).toMatchObject({
      vectorStore: { ok: true },
    });
  });
});
