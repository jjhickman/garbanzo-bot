import { logger } from '../middleware/logger.js';
import { recordVectorSearch, recordVectorUpsert } from '../middleware/stats.js';
import { config, instanceId } from './config.js';
import { embedTextForVectorSearch } from './embedding-provider.js';
import { createQdrantVectorStore } from './qdrant-store.js';
import { vectorPointId } from './vector-point-id.js';
import type { VectorFilter, VectorHit, VectorPayload, VectorStore } from './vector-store.js';

let store: VectorStore | null | undefined;
let ensureState: 'pending' | 'ok' | 'failed' = 'pending';
let sharedStore: VectorStore | null | undefined;
let sharedEnsureState: 'pending' | 'ok' | 'failed' = 'pending';

export interface SharedFactHit {
  refId: string;
  text: string;
  score: number;
  originInstance: string;
  category: string;
}

export function __setVectorStoreForTests(s: VectorStore | null): void {
  store = s;
  ensureState = 'ok';
}

export function getVectorStore(): VectorStore | null {
  if (store !== undefined) return store;
  store = config.VECTOR_STORE === 'qdrant' ? createQdrantVectorStore() : null;
  return store;
}

export function getSharedVectorStore(): VectorStore | null {
  if (!config.SHARED_MEMORY_ENABLED) return null;
  if (sharedStore !== undefined) return sharedStore;
  sharedStore = config.VECTOR_STORE === 'qdrant'
    ? createQdrantVectorStore({ collection: config.QDRANT_SHARED_COLLECTION })
    : null;
  return sharedStore;
}

async function ready(): Promise<VectorStore | null> {
  const s = getVectorStore();
  if (!s || ensureState === 'failed') return null;
  if (ensureState === 'ok') return s;

  try {
    await s.ensureCollection();
    ensureState = 'ok';
    return s;
  } catch (err) {
    ensureState = 'failed';
    logger.warn({ err }, 'Qdrant ensureCollection failed; vector memory degraded');
    return null;
  }
}

async function readyShared(): Promise<VectorStore | null> {
  const s = getSharedVectorStore();
  if (!s || sharedEnsureState === 'failed') return null;
  if (sharedEnsureState === 'ok') return s;

  try {
    await s.ensureCollection();
    sharedEnsureState = 'ok';
    return s;
  } catch (err) {
    sharedEnsureState = 'failed';
    logger.warn({ err }, 'Shared Qdrant ensureCollection failed; shared memory degraded');
    return null;
  }
}

function dims(): number {
  return config.VECTOR_EMBEDDING_DIMENSIONS;
}

/** Embed, or return null so callers fall back to keyword search without mixing vector spaces. */
async function embed(text: string): Promise<number[] | null> {
  try {
    const result = await embedTextForVectorSearch(text, dims());
    if (result.usedFallback && config.VECTOR_EMBEDDING_PROVIDER === 'openai') {
      logger.warn(
        { provider: result.provider, model: result.model },
        'Embedding used deterministic fallback; skipping vector path',
      );
      return null;
    }
    return result.vector;
  } catch (err) {
    logger.warn({ err }, 'Embedding failed; skipping vector path');
    return null;
  }
}

async function upsertOne(
  payload: VectorPayload,
  embeddingInput: string,
  readyStore: () => Promise<VectorStore | null> = ready,
): Promise<boolean> {
  const s = await readyStore();
  if (!s) return false;

  const vector = await embed(embeddingInput);
  if (!vector) {
    recordVectorUpsert('error');
    return false;
  }

  try {
    await s.upsert([{ id: vectorPointId(payload.kind, payload.refId), vector, payload }]);
    recordVectorUpsert('ok');
    return true;
  } catch (err) {
    recordVectorUpsert('error');
    logger.warn({ err, kind: payload.kind, refId: payload.refId }, 'Vector upsert failed');
    return false;
  }
}

export async function indexMessage(input: {
  chatJid: string;
  refId: string;
  sender: string;
  text: string;
  createdAt: number;
}): Promise<void> {
  await upsertOne(
    {
      kind: 'message',
      scope: 'chat',
      chatJid: input.chatJid,
      refId: input.refId,
      text: input.text,
      createdAt: input.createdAt,
      extra: { sender: input.sender },
    },
    input.text,
  );
}

export async function indexSession(input: {
  chatJid: string;
  refId: string;
  embeddingInput: string;
  summaryText: string;
  createdAt: number;
  extra?: Record<string, unknown>;
}): Promise<void> {
  await upsertOne(
    {
      kind: 'session',
      scope: 'chat',
      chatJid: input.chatJid,
      refId: input.refId,
      text: input.summaryText,
      createdAt: input.createdAt,
      extra: input.extra,
    },
    input.embeddingInput,
  );
}

export async function indexFact(input: {
  refId: string;
  text: string;
  category: string;
  createdAt: number;
}): Promise<void> {
  await upsertOne(
    {
      kind: 'fact',
      scope: 'global',
      chatJid: null,
      refId: input.refId,
      text: input.text,
      createdAt: input.createdAt,
      extra: { category: input.category },
    },
    input.text,
  );
}

export async function indexSharedFact(input: {
  localId: number | string;
  text: string;
  category: string;
}): Promise<boolean> {
  if (!config.SHARED_MEMORY_ENABLED) return false;

  return upsertOne(
    {
      kind: 'fact',
      scope: 'global',
      chatJid: null,
      refId: `${instanceId}:${input.localId}`,
      text: input.text,
      createdAt: Math.floor(Date.now() / 1000),
      extra: { originInstance: instanceId, category: input.category },
    },
    input.text,
    readyShared,
  );
}

export async function deleteFact(refId: string): Promise<void> {
  const s = await ready();
  if (!s) return;

  try {
    await s.delete({ kind: 'fact', refId });
  } catch (err) {
    logger.warn({ err, refId }, 'Vector fact delete failed');
  }
}

export async function deleteSharedFact(localId: number | string): Promise<boolean> {
  if (!config.SHARED_MEMORY_ENABLED) return false;

  const s = await readyShared();
  if (!s) return false;

  const refId = `${instanceId}:${localId}`;
  try {
    await s.delete({ kind: 'fact', refId });
    return true;
  } catch (err) {
    logger.warn({ err, refId }, 'Shared vector fact delete failed');
    return false;
  }
}

async function searchKind(
  query: string,
  filter: VectorFilter,
  limit: number,
  readyStore: () => Promise<VectorStore | null> = ready,
): Promise<VectorHit[]> {
  const s = await readyStore();
  if (!s || !query.trim()) return [];

  const vector = await embed(query);
  if (!vector) {
    recordVectorSearch('error');
    return [];
  }

  try {
    const hits = await s.search(vector, { limit, filter });
    recordVectorSearch(hits.length > 0 ? 'ok' : 'empty');
    return hits;
  } catch (err) {
    recordVectorSearch('error');
    logger.warn({ err }, 'Vector search failed; falling back to keyword');
    return [];
  }
}

export async function searchMessages(
  chatJid: string,
  query: string,
  limit: number,
): Promise<VectorHit[]> {
  return searchKind(query, { kind: 'message', chatJid }, limit);
}

export async function searchSessions(
  chatJid: string,
  query: string,
  limit: number,
): Promise<VectorHit[]> {
  return searchKind(query, { kind: 'session', chatJid }, limit);
}

export async function searchFacts(query: string, limit: number): Promise<VectorHit[]> {
  return searchKind(query, { kind: 'fact', scope: 'global' }, limit);
}

export async function searchSharedFacts(query: string, limit = 4): Promise<SharedFactHit[]> {
  if (!config.SHARED_MEMORY_ENABLED) return [];

  const hits = await searchKind(query, { kind: 'fact', scope: 'global' }, limit, readyShared);
  return hits.map((hit) => ({
    refId: hit.payload.refId,
    text: hit.payload.text,
    score: hit.score,
    originInstance: String(hit.payload.extra?.originInstance ?? 'unknown'),
    category: String(hit.payload.extra?.category ?? 'general'),
  }));
}
