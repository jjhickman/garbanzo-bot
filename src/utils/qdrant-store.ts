import { logger } from '../middleware/logger.js';
import { config } from './config.js';
import type {
  VectorFilter,
  VectorHit,
  VectorPayload,
  VectorPoint,
  VectorSearchOpts,
  VectorStore,
} from './vector-store.js';

export interface QdrantClientLike {
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  createCollection(name: string, opts: unknown): Promise<unknown>;
  upsert(name: string, opts: unknown): Promise<unknown>;
  search(name: string, opts: unknown): Promise<Array<{ id: string | number; score: number; payload: unknown }>>;
  delete(name: string, opts: unknown): Promise<unknown>;
}

export function buildQdrantFilter(filter?: VectorFilter): { must: unknown[] } | undefined {
  if (!filter) return undefined;

  const must: unknown[] = [];
  if (filter.kind !== undefined) must.push({ key: 'kind', match: { value: filter.kind } });
  if (filter.scope !== undefined) must.push({ key: 'scope', match: { value: filter.scope } });
  if (filter.chatJid !== undefined) must.push({ key: 'chatJid', match: { value: filter.chatJid } });
  if (filter.refId !== undefined) must.push({ key: 'refId', match: { value: filter.refId } });

  return must.length > 0 ? { must } : undefined;
}

async function defaultClient(): Promise<QdrantClientLike> {
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  return new QdrantClient({
    url: config.QDRANT_URL,
    apiKey: config.QDRANT_API_KEY,
  }) as unknown as QdrantClientLike;
}

export function createQdrantVectorStore(deps: { client?: QdrantClientLike } = {}): VectorStore {
  const collection = config.QDRANT_COLLECTION;
  let clientPromise: Promise<QdrantClientLike> | null = deps.client ? Promise.resolve(deps.client) : null;
  const client = () => (clientPromise ??= defaultClient());

  return {
    async ensureCollection() {
      const c = await client();
      const { collections } = await c.getCollections();
      if (collections.some((col) => col.name === collection)) return;

      await c.createCollection(collection, {
        vectors: { size: config.VECTOR_EMBEDDING_DIMENSIONS, distance: 'Cosine' },
      });
      logger.info({ collection, dims: config.VECTOR_EMBEDDING_DIMENSIONS }, 'Created Qdrant collection');
    },

    async upsert(points: VectorPoint[]) {
      if (points.length === 0) return;

      const c = await client();
      await c.upsert(collection, {
        points: points.map((point) => ({
          id: point.id,
          vector: point.vector,
          payload: point.payload,
        })),
      });
    },

    async search(vector: number[], opts: VectorSearchOpts): Promise<VectorHit[]> {
      const c = await client();
      const results = await c.search(collection, {
        vector,
        limit: opts.limit,
        with_payload: true,
        filter: buildQdrantFilter(opts.filter),
      });

      return results.map((result) => ({
        id: String(result.id),
        score: result.score,
        payload: result.payload as VectorPayload,
      }));
    },

    async delete(filter: VectorFilter): Promise<number> {
      const c = await client();
      await c.delete(collection, { filter: buildQdrantFilter(filter) });
      return 0;
    },

    async health() {
      try {
        const c = await client();
        await c.getCollections();
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
