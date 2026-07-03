process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = await import('../src/utils/config.js');
  return mod.config;
}

describe('vector store config', () => {
  afterEach(() => {
    delete process.env.VECTOR_STORE;
  });

  it('defaults to qdrant with openai 1536-dim embeddings', async () => {
    delete process.env.VECTOR_STORE;
    const config = await loadConfig({});
    expect(config.VECTOR_STORE).toBe('qdrant');
    expect(config.QDRANT_URL).toBe('http://qdrant:6333');
    expect(config.QDRANT_COLLECTION).toBe('garbanzo_memory');
    expect(config.VECTOR_EMBEDDING_PROVIDER).toBe('openai');
    expect(config.VECTOR_EMBEDDING_DIMENSIONS).toBe(1536);
  });

  it('accepts VECTOR_STORE=none for keyword-only mode', async () => {
    const config = await loadConfig({ VECTOR_STORE: 'none' });
    expect(config.VECTOR_STORE).toBe('none');
  });
});
