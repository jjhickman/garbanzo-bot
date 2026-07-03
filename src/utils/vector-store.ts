export type VectorKind = 'message' | 'session' | 'fact';
export type VectorScope = 'chat' | 'global';

export interface VectorPayload {
  kind: VectorKind;
  scope: VectorScope;
  chatJid: string | null;
  refId: string;
  text: string;
  createdAt: number;
  extra?: Record<string, unknown>;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: VectorPayload;
}

export interface VectorFilter {
  kind?: VectorKind;
  scope?: VectorScope;
  chatJid?: string | null;
  refId?: string;
}

export interface VectorSearchOpts {
  limit: number;
  filter?: VectorFilter;
}

export interface VectorHit {
  id: string;
  score: number;
  payload: VectorPayload;
}

export interface VectorStore {
  ensureCollection(): Promise<void>;
  upsert(points: VectorPoint[]): Promise<void>;
  search(vector: number[], opts: VectorSearchOpts): Promise<VectorHit[]>;
  delete(filter: VectorFilter): Promise<number>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function matchesFilter(payload: VectorPayload, filter?: VectorFilter): boolean {
  if (!filter) return true;
  if (filter.kind !== undefined && payload.kind !== filter.kind) return false;
  if (filter.scope !== undefined && payload.scope !== filter.scope) return false;
  if (filter.chatJid !== undefined && payload.chatJid !== filter.chatJid) return false;
  if (filter.refId !== undefined && payload.refId !== filter.refId) return false;
  return true;
}

export function createInMemoryVectorStore(): VectorStore {
  const points = new Map<string, VectorPoint>();
  return {
    async ensureCollection() { /* no-op */ },
    async upsert(newPoints) { for (const p of newPoints) points.set(p.id, p); },
    async search(vector, opts) {
      return [...points.values()]
        .filter((p) => matchesFilter(p.payload, opts.filter))
        .map((p) => ({ id: p.id, score: cosine(vector, p.vector), payload: p.payload }))
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.limit);
    },
    async delete(filter) {
      let removed = 0;
      for (const [id, p] of points) {
        if (matchesFilter(p.payload, filter)) { points.delete(id); removed += 1; }
      }
      return removed;
    },
    async health() { return { ok: true }; },
  };
}
