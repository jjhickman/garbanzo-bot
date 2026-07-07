process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

async function makeProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'garbanzo-rag-sources-'));
  await import('node:fs/promises').then((fs) => fs.mkdir(join(root, 'config'), { recursive: true }));
  return root;
}

async function loadModule(projectRoot: string) {
  vi.resetModules();
  vi.doMock('../src/utils/config.js', () => ({
    PROJECT_ROOT: projectRoot,
    config: {
      QDRANT_URL: 'http://qdrant.local:6333',
      QDRANT_API_KEY: undefined,
    },
  }));
  vi.doMock('../src/middleware/logger.js', () => ({
    logger: { warn: vi.fn() },
  }));
  return import('../src/utils/rag-sources.js');
}

describe('RAG sources config loader', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../src/utils/config.js');
    vi.doUnmock('../src/middleware/logger.js');
  });

  it('returns null when config/rag-sources.json is absent', async () => {
    const root = await makeProjectRoot();
    try {
      const { loadRagSources } = await loadModule(root);

      expect(loadRagSources()).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies defaults for optional source fields', async () => {
    const root = await makeProjectRoot();
    try {
      await writeFile(join(root, 'config/rag-sources.json'), JSON.stringify({
        sources: [{
          id: 'kb',
          label: 'Knowledge base',
          collection: 'kb_vectors',
          embedding: { provider: 'deterministic' },
        }],
      }));
      const { loadRagSources } = await loadModule(root);

      expect(loadRagSources()).toEqual({
        sources: [{
          id: 'kb',
          label: 'Knowledge base',
          url: 'http://qdrant.local:6333',
          apiKey: undefined,
          collection: 'kb_vectors',
          textField: 'text',
          embedding: { provider: 'deterministic', model: undefined, dimensions: undefined },
          maxHits: 3,
          minScore: 0.35,
          chats: undefined,
          enabled: true,
        }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects duplicate source ids', async () => {
    const root = await makeProjectRoot();
    try {
      const { RagSourcesConfigSchema } = await loadModule(root);

      expect(RagSourcesConfigSchema.safeParse({
        sources: [
          { id: 'dup', label: 'One', collection: 'one', embedding: { provider: 'deterministic' } },
          { id: 'dup', label: 'Two', collection: 'two', embedding: { provider: 'deterministic' } },
        ],
      }).success).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates config/rag-sources.example.json', async () => {
    const root = await makeProjectRoot();
    try {
      const { RagSourcesConfigSchema } = await loadModule(root);
      const example = JSON.parse(await readFile(resolve('config/rag-sources.example.json'), 'utf8')) as unknown;

      expect(RagSourcesConfigSchema.safeParse(example).success).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
