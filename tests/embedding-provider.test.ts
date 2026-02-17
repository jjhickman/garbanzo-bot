import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/utils/config.js';
import { embedTextForVectorSearch } from '../src/utils/embedding-provider.js';

const originalProvider = config.VECTOR_EMBEDDING_PROVIDER;
const originalModel = config.VECTOR_EMBEDDING_MODEL;
const originalOpenAiKey = config.OPENAI_API_KEY;
const originalTimeout = config.VECTOR_EMBEDDING_TIMEOUT_MS;
const originalMaxChars = config.VECTOR_EMBEDDING_MAX_CHARS;

afterEach(() => {
  config.VECTOR_EMBEDDING_PROVIDER = originalProvider;
  config.VECTOR_EMBEDDING_MODEL = originalModel;
  config.OPENAI_API_KEY = originalOpenAiKey;
  config.VECTOR_EMBEDDING_TIMEOUT_MS = originalTimeout;
  config.VECTOR_EMBEDDING_MAX_CHARS = originalMaxChars;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('embedding provider router', () => {
  it('returns deterministic embeddings by default', async () => {
    config.VECTOR_EMBEDDING_PROVIDER = 'deterministic';
    const result = await embedTextForVectorSearch('Boston trivia night in Cambridge', 8);

    expect(result.provider).toBe('deterministic');
    expect(result.model).toBe('deterministic-hash-v1');
    expect(result.usedFallback).toBe(false);
    expect(result.vector.length).toBe(8);
  });

  it('falls back to deterministic when OpenAI provider is selected without key', async () => {
    config.VECTOR_EMBEDDING_PROVIDER = 'openai';
    config.OPENAI_API_KEY = undefined;

    const result = await embedTextForVectorSearch('Need embedding key fallback test', 8);

    expect(result.provider).toBe('deterministic');
    expect(result.usedFallback).toBe(true);
    expect(result.vector.length).toBe(8);
  });

  it('uses OpenAI embeddings when configured and available', async () => {
    config.VECTOR_EMBEDDING_PROVIDER = 'openai';
    config.OPENAI_API_KEY = 'test_key';
    config.VECTOR_EMBEDDING_MODEL = 'text-embedding-3-small';

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ embedding: [0.11, 0.22, 0.33, 0.44] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    vi.stubGlobal('fetch', fetchMock);

    const result = await embedTextForVectorSearch('Use real embedding provider', 4);

    expect(result.provider).toBe('openai');
    expect(result.usedFallback).toBe(false);
    expect(result.vector).toEqual([0.11, 0.22, 0.33, 0.44]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
