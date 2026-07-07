import { z } from 'zod';

import { logger } from '../middleware/logger.js';
import { config } from './config.js';
import { embedTextDeterministic } from './text-embedding.js';
import { truncate } from './formatting.js';
import { createQdrantVectorStore, type QdrantClientLike } from './qdrant-store.js';
import { loadRagSources, type RagSource, type RagSourcesConfig } from './rag-sources.js';

const FEDERATED_PROMPT_MAX_HITS = 3;
const FEDERATED_PROMPT_LINE_TEXT_MAX = 300;
const FEDERATED_PROMPT_BLOCK_MAX = 1500;
const QDRANT_CLIENT_TIMEOUT_MS = 5_000;
const SOURCE_QUERY_DEADLINE_MS = 4_000;

export interface FederatedRagHit {
  sourceId: string;
  label: string;
  text: string;
  score: number;
}

interface RagReadHit {
  id: string;
  score: number;
  payload: unknown;
}

interface RagReadStore {
  readonly search: (vector: number[], opts: { limit: number }) => Promise<RagReadHit[]>;
}

type RagEmbedder = (text: string) => Promise<number[]>;

interface RagFederationDeps {
  loadSources: () => RagSourcesConfig | null;
  createEmbedder: (source: RagSource) => RagEmbedder;
  createStore: (source: RagSource) => RagReadStore;
}

const OpenAiEmbeddingResponseSchema = z.object({
  data: z.array(z.object({
    embedding: z.array(z.number()),
  })).min(1),
});

function normalizeInput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length <= config.VECTOR_EMBEDDING_MAX_CHARS) return trimmed;
  return trimmed.slice(0, config.VECTOR_EMBEDDING_MAX_CHARS);
}

function sourceDimensions(source: RagSource): number {
  return source.embedding.dimensions ?? config.VECTOR_EMBEDDING_DIMENSIONS;
}

function defaultCreateEmbedder(source: RagSource): RagEmbedder {
  return async (text) => {
    const normalized = normalizeInput(text);
    const dimensions = sourceDimensions(source);
    if (source.embedding.provider === 'deterministic') {
      return embedTextDeterministic(normalized, dimensions);
    }

    if (!config.OPENAI_API_KEY) {
      throw new Error(`RAG source ${source.id} uses openai embeddings but OPENAI_API_KEY is unset`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.VECTOR_EMBEDDING_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: source.embedding.model ?? config.VECTOR_EMBEDDING_MODEL,
          input: normalized,
          dimensions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenAI embeddings failed with status ${response.status}`);
      }

      const data = OpenAiEmbeddingResponseSchema.parse(await response.json());
      const embedding = data.data[0]?.embedding ?? [];
      if (embedding.length !== dimensions) {
        throw new Error(`OpenAI embedding dimensions mismatch: expected ${dimensions}, got ${embedding.length}`);
      }
      return embedding;
    } finally {
      clearTimeout(timeout);
    }
  };
}

function lazyQdrantClient(source: RagSource): QdrantClientLike {
  let clientPromise: Promise<QdrantClientLike> | null = null;
  const client = async (): Promise<QdrantClientLike> => {
    clientPromise ??= import('@qdrant/js-client-rest').then(({ QdrantClient }) =>
      new QdrantClient({
        url: source.url,
        apiKey: source.apiKey,
        timeout: QDRANT_CLIENT_TIMEOUT_MS,
      }) as unknown as QdrantClientLike);
    return clientPromise;
  };

  return {
    getCollections: async () => (await client()).getCollections(),
    getCollection: async (name) => (await client()).getCollection(name),
    createCollection: async (name, opts) => (await client()).createCollection(name, opts),
    upsert: async (name, opts) => (await client()).upsert(name, opts),
    search: async (name, opts) => (await client()).search(name, opts),
    delete: async (name, opts) => (await client()).delete(name, opts),
  };
}

function defaultCreateStore(source: RagSource): RagReadStore {
  // Pick off only the search method so callers (and future edits) can never
  // reach the underlying store's write/admin surface (upsert/delete/etc).
  const { search } = createQdrantVectorStore({
    client: lazyQdrantClient(source),
    collection: source.collection,
  });
  return { search };
}

let deps: RagFederationDeps = {
  loadSources: loadRagSources,
  createEmbedder: defaultCreateEmbedder,
  createStore: defaultCreateStore,
};
const stores = new Map<string, RagReadStore>();

export function __setRagFederationDepsForTests(overrides: Partial<RagFederationDeps>): void {
  deps = { ...deps, ...overrides };
  stores.clear();
}

function allowedForChat(source: RagSource, chatId: string): boolean {
  return source.chats === undefined || source.chats.includes(chatId);
}

function sourceStore(source: RagSource): RagReadStore {
  const existing = stores.get(source.id);
  if (existing) return existing;
  const store = deps.createStore(source);
  stores.set(source.id, store);
  return store;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function payloadText(payload: unknown, textField: string): string | null {
  if (!isRecord(payload)) return null;
  const text = payload[textField];
  return typeof text === 'string' && text.trim() ? text : null;
}

// Races `promise` against a timer so one unreachable/slow source can never stall
// the whole federated query. The timer is always cleared (and unref'd, so it
// can't hold the process or a fake-timers test open) once either side settles.
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`source query deadline of ${ms}ms exceeded`)), ms);
    timer.unref?.();
  });

  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function querySource(source: RagSource, query: string): Promise<FederatedRagHit[]> {
  const vector = await deps.createEmbedder(source)(query);
  const hits = await sourceStore(source).search(vector, { limit: source.maxHits });

  const hitsForSource: FederatedRagHit[] = [];
  for (const hit of hits.filter((candidate) => candidate.score >= source.minScore).slice(0, source.maxHits)) {
    const text = payloadText(hit.payload, source.textField);
    if (!text) continue;
    hitsForSource.push({
      sourceId: source.id,
      label: source.label,
      text,
      score: hit.score,
    });
  }
  return hitsForSource;
}

export async function searchFederatedSources(query: string, chatId: string): Promise<FederatedRagHit[]> {
  if (!config.RAG_FEDERATION_ENABLED || !query.trim()) return [];

  const sources = deps.loadSources();
  if (!sources) return [];

  const activeSources = sources.sources.filter((source) => source.enabled && allowedForChat(source, chatId));

  // Query every source concurrently (each bounded by its own deadline) so one
  // slow/unreachable source cannot stall the others.
  const settled = await Promise.allSettled(
    activeSources.map((source) => withDeadline(querySource(source, query), SOURCE_QUERY_DEADLINE_MS)),
  );

  const results: FederatedRagHit[] = [];
  settled.forEach((outcome, index) => {
    const source = activeSources[index];
    if (outcome.status === 'rejected') {
      logger.warn({ err: outcome.reason, sourceId: source.id }, 'Federated RAG source failed; continuing without it');
      return;
    }
    results.push(...outcome.value);
  });

  return results;
}

export async function formatFederatedKnowledgeForPrompt(query: string | undefined, chatId: string): Promise<string> {
  if (!config.RAG_FEDERATION_ENABLED || !query?.trim()) return '';

  const hits = (await searchFederatedSources(query, chatId)).slice(0, FEDERATED_PROMPT_MAX_HITS);
  if (hits.length === 0) return '';

  const lines = [
    'Federated knowledge (read-only source hits):',
    ...hits.map((hit) => `  - [${hit.label}] ${truncate(hit.text, FEDERATED_PROMPT_LINE_TEXT_MAX)}`),
  ];
  return truncate(lines.join('\n'), FEDERATED_PROMPT_BLOCK_MAX);
}
