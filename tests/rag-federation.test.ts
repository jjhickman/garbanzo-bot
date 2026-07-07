process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RagSource, RagSourcesConfig } from '../src/utils/rag-sources.js';

const baseSource: RagSource = {
  id: 'kb',
  label: 'Knowledge base',
  url: 'http://qdrant.local:6333',
  apiKey: undefined,
  collection: 'kb_vectors',
  textField: 'text',
  embedding: { provider: 'deterministic', model: undefined, dimensions: 8 },
  maxHits: 3,
  minScore: 0.35,
  chats: undefined,
  enabled: true,
};

function source(overrides: Partial<RagSource>): RagSource {
  return { ...baseSource, ...overrides, embedding: { ...baseSource.embedding, ...overrides.embedding } };
}

async function loadFederation(enabled = true) {
  vi.resetModules();
  vi.doMock('../src/utils/config.js', () => ({
    PROJECT_ROOT: '/tmp',
    config: {
      RAG_FEDERATION_ENABLED: enabled,
      QDRANT_URL: 'http://qdrant.local:6333',
      QDRANT_API_KEY: undefined,
      OPENAI_API_KEY: 'test_openai_key',
      VECTOR_EMBEDDING_MODEL: 'text-embedding-3-small',
      VECTOR_EMBEDDING_DIMENSIONS: 1536,
      VECTOR_EMBEDDING_TIMEOUT_MS: 12000,
      VECTOR_EMBEDDING_MAX_CHARS: 4000,
      MESSAGING_PLATFORM: 'whatsapp',
      AI_TOOL_CALLING: false,
      BAND_FEATURES_ENABLED: false,
    },
  }));
  vi.doMock('../src/middleware/logger.js', () => ({
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  }));
  return import('../src/utils/rag-federation.js');
}

describe('RAG source federation', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../src/utils/config.js');
    vi.doUnmock('../src/middleware/logger.js');
    vi.restoreAllMocks();
  });

  it('embeds each source with that source embedding config and maps labels/text fields', async () => {
    const mod = await loadFederation();
    const sources: RagSourcesConfig = {
      sources: [
        source({
          id: 'manual',
          label: 'Runbook',
          textField: 'body',
          embedding: { provider: 'deterministic', model: 'manual-model', dimensions: 4 },
        }),
        source({
          id: 'archive',
          label: 'Archive',
          collection: 'archive_vectors',
          embedding: { provider: 'openai', model: 'text-embedding-3-large', dimensions: 3072 },
        }),
      ],
    };
    const embedCalls: Array<{ sourceId: string; model: string | undefined; text: string }> = [];

    mod.__setRagFederationDepsForTests({
      loadSources: () => sources,
      createEmbedder: (s) => async (text) => {
        embedCalls.push({ sourceId: s.id, model: s.embedding.model, text });
        return s.id === 'manual' ? [1, 0, 0, 0] : [0, 1, 0, 0];
      },
      createStore: (s) => ({
        search: vi.fn(async () => [{
          id: `${s.id}-1`,
          score: 0.91,
          payload: s.id === 'manual'
            ? { body: 'manual body text' }
            : { text: 'archive text' },
        }]),
      }),
    });

    await expect(mod.searchFederatedSources('amp settings', 'chat-a')).resolves.toEqual([
      { sourceId: 'manual', label: 'Runbook', text: 'manual body text', score: 0.91 },
      { sourceId: 'archive', label: 'Archive', text: 'archive text', score: 0.91 },
    ]);
    expect(embedCalls).toEqual([
      { sourceId: 'manual', model: 'manual-model', text: 'amp settings' },
      { sourceId: 'archive', model: 'text-embedding-3-large', text: 'amp settings' },
    ]);
  });

  it('filters sources by chat allowlist before constructing stores', async () => {
    const mod = await loadFederation();
    const createStore = vi.fn((s: RagSource) => ({
      search: vi.fn(async () => [{
        id: s.id,
        score: 0.9,
        payload: { text: s.label },
      }]),
    }));

    mod.__setRagFederationDepsForTests({
      loadSources: () => ({
        sources: [
          source({ id: 'private', label: 'Private', chats: ['chat-a'] }),
          source({ id: 'global', label: 'Global' }),
        ],
      }),
      createEmbedder: () => async () => [1, 2, 3],
      createStore,
    });

    await expect(mod.searchFederatedSources('query', 'chat-b')).resolves.toEqual([
      { sourceId: 'global', label: 'Global', text: 'Global', score: 0.9 },
    ]);
    expect(createStore).toHaveBeenCalledTimes(1);
    expect(createStore.mock.calls[0]?.[0].id).toBe('global');
  });

  it('applies minScore and maxHits per source', async () => {
    const mod = await loadFederation();
    const search = vi.fn(async () => [
      { id: '1', score: 0.95, payload: { text: 'keep one' } },
      { id: '2', score: 0.4, payload: { text: 'drop low score' } },
      { id: '3', score: 0.9, payload: { text: 'keep two' } },
      { id: '4', score: 0.89, payload: { text: 'over max' } },
    ]);

    mod.__setRagFederationDepsForTests({
      loadSources: () => ({ sources: [source({ maxHits: 2, minScore: 0.8 })] }),
      createEmbedder: () => async () => [1, 2, 3],
      createStore: () => ({ search }),
    });

    await expect(mod.searchFederatedSources('query', 'chat-a')).resolves.toEqual([
      { sourceId: 'kb', label: 'Knowledge base', text: 'keep one', score: 0.95 },
      { sourceId: 'kb', label: 'Knowledge base', text: 'keep two', score: 0.9 },
    ]);
    expect(search).toHaveBeenCalledWith([1, 2, 3], { limit: 2 });
  });

  it('isolates source errors and keeps returning healthy source hits', async () => {
    const mod = await loadFederation();

    mod.__setRagFederationDepsForTests({
      loadSources: () => ({
        sources: [
          source({ id: 'broken', label: 'Broken' }),
          source({ id: 'healthy', label: 'Healthy' }),
        ],
      }),
      createEmbedder: (s) => async () => {
        if (s.id === 'broken') throw new Error('embed failed');
        return [1, 2, 3];
      },
      createStore: () => ({
        search: vi.fn(async () => [{ id: 'ok', score: 0.88, payload: { text: 'healthy text' } }]),
      }),
    });

    await expect(mod.searchFederatedSources('query', 'chat-a')).resolves.toEqual([
      { sourceId: 'healthy', label: 'Healthy', text: 'healthy text', score: 0.88 },
    ]);
  });

  it('does not construct stores while disabled', async () => {
    const mod = await loadFederation(false);
    const createStore = vi.fn();

    mod.__setRagFederationDepsForTests({
      loadSources: () => ({ sources: [source({})] }),
      createEmbedder: () => async () => [1, 2, 3],
      createStore,
    });

    await expect(mod.searchFederatedSources('query', 'chat-a')).resolves.toEqual([]);
    expect(createStore).not.toHaveBeenCalled();
  });

  it('keeps the prompt byte-identical when the flag is off', async () => {
    const mod = await loadFederation(false);
    const createStore = vi.fn();
    mod.__setRagFederationDepsForTests({
      loadSources: () => ({ sources: [source({})] }),
      createEmbedder: () => async () => [1, 2, 3],
      createStore,
    });
    vi.doMock('../src/middleware/context.js', () => ({
      formatContext: vi.fn(async () => ''),
    }));
    vi.doMock('../src/features/language.js', () => ({
      buildLanguageInstruction: vi.fn(() => ''),
    }));
    vi.doMock('../src/features/introductions.js', () => ({
      INTRO_SYSTEM_ADDENDUM: 'INTRO ADDENDUM',
    }));
    vi.doMock('../src/features/web-search.js', () => ({
      getSearchProviderName: vi.fn(() => null),
    }));
    vi.doMock('../src/core/groups-config.js', () => ({
      getGroupPersona: vi.fn(() => null),
      getEnabledGroupJidByName: vi.fn(() => null),
    }));
    vi.doMock('../src/utils/db.js', () => ({
      formatMemoriesForPromptWithShared: vi.fn(async () => 'Memory block'),
    }));
    vi.doMock('../src/features/band-knowledge.js', () => ({
      formatBandKnowledgeForPrompt: vi.fn(async () => ''),
    }));

    const { buildSystemPrompt } = await import('../src/ai/persona.js');
    const prompt = await buildSystemPrompt({
      groupName: 'General',
      groupJid: 'chat-a',
      senderJid: 'sender',
    }, 'query');

    expect(prompt).toBe([
      'You are Garbanzo Bean, a community chat bot. Be warm, direct, and helpful.',
      '---',
      'You are currently in the "General" group chat.',
      '',
      'Memory block',
      'Keep responses concise and use WhatsApp formatting (*bold*, _italic_, ~strike~).',
      'If you are still unsure about something after using your tools, say so honestly.',
    ].join('\n'));
    expect(createStore).not.toHaveBeenCalled();
  });
});
