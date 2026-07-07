import { logger } from '../middleware/logger.js';
import { config } from './config.js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import type {
  VectorFilter,
  VectorHit,
  VectorPayload,
  VectorPoint,
  VectorSearchOpts,
  VectorStore,
} from './vector-store.js';

type QdrantCollectionInfo = Awaited<ReturnType<QdrantClient['getCollection']>>;

export interface QdrantClientLike {
  getCollections(): Promise<{ collections: Array<{ name: string }> }>;
  getCollection(name: string): Promise<QdrantCollectionInfo>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}

function getVectorSize(info: QdrantCollectionInfo): number | undefined {
  const vectors = info.config.params.vectors;
  if (!isRecord(vectors)) return undefined;

  const vectorConfigs: Record<string, unknown> = vectors;
  const directSize = numberField(vectorConfigs, 'size');
  if (directSize !== undefined) return directSize;

  for (const vectorConfig of Object.values(vectorConfigs)) {
    const size = numberField(vectorConfig, 'size');
    if (size !== undefined) return size;
  }

  return undefined;
}

export function createQdrantVectorStore(deps: {
  client?: QdrantClientLike;
  collection?: string;
} = {}): VectorStore {
  const collection = deps.collection ?? config.QDRANT_COLLECTION;
  let clientPromise: Promise<QdrantClientLike> | null = deps.client ? Promise.resolve(deps.client) : null;
  const client = () => (clientPromise ??= defaultClient());

  return {
    async ensureCollection() {
      const c = await client();
      const { collections } = await c.getCollections();
      if (collections.some((col) => col.name === collection)) {
        const existing = getVectorSize(await c.getCollection(collection));
        if (existing !== undefined && existing !== config.VECTOR_EMBEDDING_DIMENSIONS) {
          logger.error(
            { collection, existing, expected: config.VECTOR_EMBEDDING_DIMENSIONS },
            'Qdrant collection dimension mismatch; re-create the collection or run backfill after changing embedding model/dims',
          );
        }
        return;
      }

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
