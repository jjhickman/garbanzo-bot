# Qdrant Memory RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace garbanzo-bot's Postgres-only pgvector retrieval with a self-hosted Qdrant vector store that serves semantic memory (messages, session summaries, community facts) in every deployment.

**Architecture:** A backend-agnostic `VectorStore` interface with a `QdrantVectorStore` implementation, orchestrated by a `vector-memory` module that the context pipeline, memory feature, and search tool call. The relational DB (SQLite/Postgres) stays the system of record for canonical rows; all vectors live in one Qdrant collection filtered by payload. Embeddings default to OpenAI `text-embedding-3-small` at 1536 dims, with a keyword fallback whenever Qdrant or embeddings are unavailable.

**Tech Stack:** TypeScript (ESM), Node 20+, `@qdrant/js-client-rest`, Zod, Vitest, Docker Compose, Qdrant.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-07-03-qdrant-memory-rag-design.md`. Every task serves it.
- **TypeScript strict mode** — no `any`, ES Modules only (`import`/`export`, `.js` extensions in import paths), never CommonJS.
- **Zod** validates all external input (config, Qdrant responses). **Pino** logger only — never `console.log`.
- **Files:** `kebab-case.ts`, one concern per file, max ~300 lines.
- **Never block or crash a reply.** All vector writes are best-effort/async; every read path has a keyword fallback and never throws into the reply path.
- **Never mix embedding spaces:** a failed OpenAI embedding must NOT be silently replaced by a deterministic vector at runtime — fall back to keyword search instead. Deterministic embedding is for tests/offline (`VECTOR_EMBEDDING_PROVIDER=deterministic`) only.
- **Embeddings default:** `VECTOR_EMBEDDING_PROVIDER=openai`, model `text-embedding-3-small`, `VECTOR_EMBEDDING_DIMENSIONS=1536`. Qdrant collection vector size must equal `VECTOR_EMBEDDING_DIMENSIONS`.
- **Config default:** `VECTOR_STORE=qdrant`, `QDRANT_URL=http://qdrant:6333`, `QDRANT_COLLECTION=garbanzo_memory`, `QDRANT_API_KEY` optional.
- **Ask-first (AGENTS.md):** adding the `@qdrant/js-client-rest` dependency, changing AI routing, and `config/groups.json` edits require owner approval. This plan adds the dependency in Task 2 — owner has approved it as part of approving this plan.
- **Commits:** `type: description`; author `Josh Hickman <25596491+jjhickman@users.noreply.github.com>`; run `npm run check` (CI env: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter`) before commits that touch source. Never merge — push branch, open/update PR, owner merges.
- **Branch:** `feat/qdrant-memory-rag` (already created, spec already committed there).

---

## File Structure

**Create:**
- `src/utils/vector-store.ts` — `VectorStore` interface + `VectorPoint`, `VectorHit`, `VectorFilter`, `VectorSearchOpts`, `VectorKind`, `VectorScope` types. No Qdrant/HTTP specifics.
- `src/utils/qdrant-store.ts` — `QdrantVectorStore implements VectorStore`; the only file importing `@qdrant/js-client-rest`.
- `src/utils/vector-memory.ts` — orchestration: embed + upsert/search + degradation policy + metrics. The single entry point features call.
- `src/utils/vector-point-id.ts` — deterministic point-id derivation (`kind:refId` → stable UUID).
- `src/utils/vector-backfill.ts` — resumable one-shot re-index of messages/sessions/facts into Qdrant (generalizes `session-backfill.ts`).
- `scripts/backfill-vectors.mjs` — CLI wrapper (`npm run backfill:vectors`).
- Tests: `tests/vector-store-fake.test.ts`, `tests/qdrant-store.test.ts`, `tests/vector-memory.test.ts`, `tests/vector-point-id.test.ts`, `tests/vector-backfill.test.ts`, `tests/vector-memory-integration.test.ts`.

**Modify:**
- `src/utils/config.ts` — new keys + changed defaults.
- `.env.example` — document new keys.
- `src/middleware/stats.ts` — vector upsert/search counters.
- `src/middleware/context.ts` — retrieval goes through `vector-memory`.
- `src/utils/db.ts` — `searchMemory` gains a semantic path via `vector-memory`; export a `getAllMemories`-based indexing hook.
- `src/features/memory.ts` / memory write path — index/delete fact vectors.
- `src/utils/db-postgres.ts` — remove `message_vectors` / `conversation_session_vectors` create/query/delete (Task 11).
- `src/utils/db-sqlite.ts` — `searchRelevant*` keyword functions become the fallback only (kept; still used when `VECTOR_STORE=none` or Qdrant down).
- `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.prod.yml`, `docker-compose.aws.yml` — add `qdrant` service.
- `.github/workflows/ci.yml` — Qdrant service container for the integration job.
- `package.json` — dependency + `backfill:vectors` script.
- `AGENTS.md` — decisions log entry.

---

## Task 1: Config keys and defaults

**Files:**
- Modify: `src/utils/config.ts:188-191` (VECTOR_* block)
- Modify: `.env.example`
- Test: `tests/config-vector-store.test.ts`

**Interfaces:**
- Produces: `config.VECTOR_STORE: 'qdrant' | 'none'`, `config.QDRANT_URL: string`, `config.QDRANT_API_KEY: string | undefined`, `config.QDRANT_COLLECTION: string`, `config.VECTOR_EMBEDDING_DIMENSIONS: number`, and changed default `config.VECTOR_EMBEDDING_PROVIDER` (now `'openai'`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/config-vector-store.test.ts
process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it, vi } from 'vitest';

async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = await import('../src/utils/config.js');
  return mod.config;
}

describe('vector store config', () => {
  it('defaults to qdrant with openai 1536-dim embeddings', async () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/config-vector-store.test.ts`
Expected: FAIL — `VECTOR_STORE` is undefined.

- [ ] **Step 3: Add the config keys**

In `src/utils/config.ts`, extend the schema near the existing VECTOR_* block (line ~188):

```typescript
  VECTOR_STORE: z.enum(['qdrant', 'none']).default('qdrant'),
  QDRANT_URL: z.string().url().default('http://qdrant:6333'),
  QDRANT_API_KEY: z.string().min(1).optional(),
  QDRANT_COLLECTION: z.string().min(1).default('garbanzo_memory'),
  VECTOR_EMBEDDING_PROVIDER: z.enum(['deterministic', 'openai']).default('openai'),
  VECTOR_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  VECTOR_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(3072).default(1536),
```

(Replace the existing `VECTOR_EMBEDDING_PROVIDER` line — default flips from `deterministic` to `openai`. Leave `VECTOR_EMBEDDING_TIMEOUT_MS` and `VECTOR_EMBEDDING_MAX_CHARS` as-is.)

- [ ] **Step 4: Document in `.env.example`**

Add under the AI/vector section:

```bash
# ── Vector memory (Qdrant) ──
# VECTOR_STORE: qdrant (semantic memory) or none (keyword-only)
VECTOR_STORE=qdrant
QDRANT_URL=http://qdrant:6333
# QDRANT_API_KEY=            # optional; set for hardened/remote Qdrant
QDRANT_COLLECTION=garbanzo_memory
VECTOR_EMBEDDING_PROVIDER=openai   # openai | deterministic (tests/offline)
VECTOR_EMBEDDING_MODEL=text-embedding-3-small
VECTOR_EMBEDDING_DIMENSIONS=1536
```

- [ ] **Step 5: Run test to verify it passes**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/config-vector-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/utils/config.ts .env.example tests/config-vector-store.test.ts
git commit -m "feat(config): add VECTOR_STORE/QDRANT_* keys, default embeddings to openai 1536"
```

---

## Task 2: Add Qdrant dependency and Docker Compose service

**Files:**
- Modify: `package.json`
- Modify: `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.prod.yml`, `docker-compose.aws.yml`
- Test: `tests/compose-qdrant.test.ts`

**Interfaces:**
- Produces: a running `qdrant` service reachable at `http://qdrant:6333` inside compose; `@qdrant/js-client-rest` importable.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/compose-qdrant.test.ts
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const composeFiles = [
  'docker-compose.yml',
  'docker-compose.prod.yml',
];

describe('qdrant compose service', () => {
  for (const file of composeFiles) {
    it(`${file} defines a qdrant service with a persistent volume`, () => {
      const text = readFileSync(file, 'utf-8');
      expect(text).toMatch(/qdrant:/);
      expect(text).toMatch(/qdrant\/qdrant/);
      expect(text).toMatch(/\/qdrant\/storage/);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compose-qdrant.test.ts`
Expected: FAIL — no `qdrant` service.

- [ ] **Step 3: Install the dependency**

Run: `npm install @qdrant/js-client-rest`
Expected: `package.json` dependencies gains `@qdrant/js-client-rest`.

- [ ] **Step 4: Add the qdrant service to each compose file**

Add to the `services:` block of `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.prod.yml`, `docker-compose.aws.yml` (match each file's existing indentation and volume-declaration style):

```yaml
  qdrant:
    image: qdrant/qdrant:latest
    restart: unless-stopped
    volumes:
      - qdrant_data:/qdrant/storage
    healthcheck:
      test: ["CMD", "sh", "-c", "wget -qO- http://127.0.0.1:6333/readyz || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
```

Add `qdrant_data:` to the top-level `volumes:` block in each file, and add `qdrant` to the bot service's `depends_on:`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/compose-qdrant.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json docker-compose*.yml tests/compose-qdrant.test.ts
git commit -m "feat(infra): add self-hosted Qdrant service + @qdrant/js-client-rest"
```

---

## Task 3: Deterministic point-id derivation

**Files:**
- Create: `src/utils/vector-point-id.ts`
- Test: `tests/vector-point-id.test.ts`

**Interfaces:**
- Produces: `vectorPointId(kind: VectorKind, refId: string): string` — returns a stable UUID string so re-upserts of the same `(kind, refId)` overwrite rather than duplicate. (`VectorKind` from Task 4; for this task inline the string union `'message' | 'session' | 'fact'`.)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/vector-point-id.test.ts
import { describe, expect, it } from 'vitest';
import { vectorPointId } from '../src/utils/vector-point-id.js';

describe('vectorPointId', () => {
  it('is deterministic for the same kind + refId', () => {
    expect(vectorPointId('message', '42')).toBe(vectorPointId('message', '42'));
  });

  it('differs by kind and by refId', () => {
    expect(vectorPointId('message', '42')).not.toBe(vectorPointId('session', '42'));
    expect(vectorPointId('message', '42')).not.toBe(vectorPointId('message', '43'));
  });

  it('returns a canonical UUID string (Qdrant-compatible id)', () => {
    expect(vectorPointId('fact', '7')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vector-point-id.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement UUIDv5-style derivation**

```typescript
// src/utils/vector-point-id.ts
import { createHash } from 'crypto';

/** Fixed namespace so ids are stable across runs. */
const NAMESPACE = 'garbanzo-vector-memory-v1';

/**
 * Derive a deterministic, Qdrant-compatible UUID from a memory kind and the
 * canonical row id. Same input → same id, so upserts overwrite in place.
 */
export function vectorPointId(kind: 'message' | 'session' | 'fact', refId: string): string {
  const hash = createHash('sha1').update(`${NAMESPACE}:${kind}:${refId}`).digest('hex');
  // Format 16 bytes of the digest as a v5-style UUID.
  const h = hash.slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vector-point-id.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/vector-point-id.ts tests/vector-point-id.test.ts
git commit -m "feat(vector): deterministic Qdrant point-id derivation"
```

---

## Task 4: VectorStore interface + in-memory fake

**Files:**
- Create: `src/utils/vector-store.ts`
- Test: `tests/vector-store-fake.test.ts`

**Interfaces:**
- Produces the contract every consumer depends on:

```typescript
export type VectorKind = 'message' | 'session' | 'fact';
export type VectorScope = 'chat' | 'global';

export interface VectorPayload {
  kind: VectorKind;
  scope: VectorScope;
  chatJid: string | null;
  refId: string;
  text: string;
  createdAt: number;              // unix epoch seconds
  extra?: Record<string, unknown>;
}

export interface VectorPoint {
  id: string;                      // from vectorPointId()
  vector: number[];
  payload: VectorPayload;
}

export interface VectorFilter {
  kind?: VectorKind;
  scope?: VectorScope;
  chatJid?: string | null;
}

export interface VectorSearchOpts {
  limit: number;
  filter?: VectorFilter;
}

export interface VectorHit {
  id: string;
  score: number;                   // cosine similarity (higher = closer)
  payload: VectorPayload;
}

export interface VectorStore {
  ensureCollection(): Promise<void>;
  upsert(points: VectorPoint[]): Promise<void>;
  search(vector: number[], opts: VectorSearchOpts): Promise<VectorHit[]>;
  delete(filter: VectorFilter): Promise<number>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}
```
- Also produces: `createInMemoryVectorStore(): VectorStore` (test/`none`-mode fake, cosine-ranked).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/vector-store-fake.test.ts
import { describe, expect, it } from 'vitest';
import { createInMemoryVectorStore, type VectorPoint } from '../src/utils/vector-store.js';

function pt(id: string, vector: number[], over: Partial<VectorPoint['payload']> = {}): VectorPoint {
  return {
    id,
    vector,
    payload: { kind: 'message', scope: 'chat', chatJid: 'g1', refId: id, text: id, createdAt: 0, ...over },
  };
}

describe('in-memory vector store', () => {
  it('ranks by cosine similarity and honors limit', async () => {
    const store = createInMemoryVectorStore();
    await store.ensureCollection();
    await store.upsert([pt('a', [1, 0]), pt('b', [0, 1]), pt('c', [0.9, 0.1])]);
    const hits = await store.search([1, 0], { limit: 2 });
    expect(hits.map((h) => h.id)).toEqual(['a', 'c']);
  });

  it('filters by kind, scope, and chatJid', async () => {
    const store = createInMemoryVectorStore();
    await store.upsert([
      pt('m', [1, 0], { kind: 'message', chatJid: 'g1' }),
      pt('f', [1, 0], { kind: 'fact', scope: 'global', chatJid: null }),
    ]);
    const facts = await store.search([1, 0], { limit: 5, filter: { kind: 'fact', scope: 'global' } });
    expect(facts.map((h) => h.id)).toEqual(['f']);
    const g1 = await store.search([1, 0], { limit: 5, filter: { chatJid: 'g1' } });
    expect(g1.map((h) => h.id)).toEqual(['m']);
  });

  it('upsert overwrites by id and delete removes by filter', async () => {
    const store = createInMemoryVectorStore();
    await store.upsert([pt('a', [1, 0])]);
    await store.upsert([pt('a', [0, 1])]);
    expect((await store.search([0, 1], { limit: 1 }))[0].id).toBe('a');
    const removed = await store.delete({ chatJid: 'g1' });
    expect(removed).toBe(1);
    expect(await store.search([0, 1], { limit: 1 })).toEqual([]);
  });

  it('reports healthy', async () => {
    expect((await createInMemoryVectorStore().health()).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vector-store-fake.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the interface + fake**

Create `src/utils/vector-store.ts` with the types above, then:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vector-store-fake.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/vector-store.ts tests/vector-store-fake.test.ts
git commit -m "feat(vector): VectorStore interface + in-memory fake"
```

---

## Task 5: QdrantVectorStore implementation

**Files:**
- Create: `src/utils/qdrant-store.ts`
- Test: `tests/qdrant-store.test.ts`

**Interfaces:**
- Consumes: `VectorStore`, `VectorPoint`, `VectorFilter`, `VectorHit` from Task 4; `config` from Task 1.
- Produces: `createQdrantVectorStore(deps?: { client?: QdrantClientLike }): VectorStore` where `QdrantClientLike` is a minimal interface (`getCollections`, `createCollection`, `upsert`, `search`, `delete`) so tests inject a fake client without a live server.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/qdrant-store.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildQdrantFilter, createQdrantVectorStore } from '../src/utils/qdrant-store.js';

describe('buildQdrantFilter', () => {
  it('maps our filter to Qdrant must-conditions', () => {
    expect(buildQdrantFilter({ kind: 'fact', scope: 'global', chatJid: null })).toEqual({
      must: [
        { key: 'kind', match: { value: 'fact' } },
        { key: 'scope', match: { value: 'global' } },
        { key: 'chatJid', match: { value: null } },
      ],
    });
  });

  it('omits undefined fields and returns undefined for empty filter', () => {
    expect(buildQdrantFilter({ kind: 'message' })).toEqual({
      must: [{ key: 'kind', match: { value: 'message' } }],
    });
    expect(buildQdrantFilter(undefined)).toBeUndefined();
  });
});

describe('createQdrantVectorStore', () => {
  it('creates the collection when missing', async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [] }),
      createCollection: vi.fn().mockResolvedValue(true),
      upsert: vi.fn(), search: vi.fn(), delete: vi.fn(),
    };
    const store = createQdrantVectorStore({ client });
    await store.ensureCollection();
    expect(client.createCollection).toHaveBeenCalledWith(
      'garbanzo_memory',
      expect.objectContaining({ vectors: expect.objectContaining({ size: 1536, distance: 'Cosine' }) }),
    );
  });

  it('maps Qdrant search results to VectorHit', async () => {
    const client = {
      getCollections: vi.fn().mockResolvedValue({ collections: [{ name: 'garbanzo_memory' }] }),
      createCollection: vi.fn(),
      upsert: vi.fn(),
      search: vi.fn().mockResolvedValue([
        { id: 'x', score: 0.9, payload: { kind: 'message', scope: 'chat', chatJid: 'g1', refId: '1', text: 'hi', createdAt: 5 } },
      ]),
      delete: vi.fn(),
    };
    const store = createQdrantVectorStore({ client });
    const hits = await store.search([1, 0], { limit: 3, filter: { chatJid: 'g1' } });
    expect(hits).toEqual([
      { id: 'x', score: 0.9, payload: { kind: 'message', scope: 'chat', chatJid: 'g1', refId: '1', text: 'hi', createdAt: 5 } },
    ]);
    expect(client.search).toHaveBeenCalledWith('garbanzo_memory', expect.objectContaining({
      vector: [1, 0], limit: 3, with_payload: true,
      filter: { must: [{ key: 'chatJid', match: { value: 'g1' } }] },
    }));
  });

  it('health returns ok:false when the client throws', async () => {
    const client = {
      getCollections: vi.fn().mockRejectedValue(new Error('conn refused')),
      createCollection: vi.fn(), upsert: vi.fn(), search: vi.fn(), delete: vi.fn(),
    };
    const store = createQdrantVectorStore({ client });
    const h = await store.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('conn refused');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/qdrant-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `qdrant-store.ts`**

```typescript
// src/utils/qdrant-store.ts
import { config } from './config.js';
import { logger } from '../middleware/logger.js';
import type {
  VectorFilter, VectorHit, VectorPoint, VectorSearchOpts, VectorStore, VectorPayload,
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
  return must.length > 0 ? { must } : undefined;
}

async function defaultClient(): Promise<QdrantClientLike> {
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  return new QdrantClient({ url: config.QDRANT_URL, apiKey: config.QDRANT_API_KEY }) as unknown as QdrantClientLike;
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
        points: points.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload })),
      });
    },
    async search(vector: number[], opts: VectorSearchOpts): Promise<VectorHit[]> {
      const c = await client();
      const results = await c.search(collection, {
        vector, limit: opts.limit, with_payload: true, filter: buildQdrantFilter(opts.filter),
      });
      return results.map((r) => ({ id: String(r.id), score: r.score, payload: r.payload as VectorPayload }));
    },
    async delete(filter: VectorFilter): Promise<number> {
      const c = await client();
      await c.delete(collection, { filter: buildQdrantFilter(filter) });
      return 0; // Qdrant delete-by-filter does not return a count; callers treat 0 as "unknown".
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/qdrant-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/qdrant-store.ts tests/qdrant-store.test.ts
git commit -m "feat(vector): QdrantVectorStore implementation with injectable client"
```

---

## Task 6: Stats counters for vector operations

**Files:**
- Modify: `src/middleware/stats.ts:22-26` (counter fields), `:116-120` (init), and add recorder functions near `recordSessionEmbedding` (`:237`)
- Test: `tests/vector-stats.test.ts`

**Interfaces:**
- Produces: `recordVectorUpsert(outcome: 'ok' | 'error'): void`, `recordVectorSearch(outcome: 'ok' | 'empty' | 'error'): void`, and stat fields `vectorUpsertsOk`, `vectorUpsertFailures`, `vectorSearchesOk`, `vectorSearchFailures`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/vector-stats.test.ts
process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it } from 'vitest';
import { recordVectorUpsert, recordVectorSearch, getStatsSnapshot } from '../src/middleware/stats.js';

describe('vector stats', () => {
  it('counts upsert and search outcomes', () => {
    recordVectorUpsert('ok');
    recordVectorUpsert('error');
    recordVectorSearch('error');
    const snap = getStatsSnapshot();
    expect(snap.vectorUpsertsOk).toBeGreaterThanOrEqual(1);
    expect(snap.vectorUpsertFailures).toBeGreaterThanOrEqual(1);
    expect(snap.vectorSearchFailures).toBeGreaterThanOrEqual(1);
  });
});
```

(If the snapshot accessor has a different name, match the existing export in `stats.ts` — check how `sessionSummaryRetrievalHits` is read in `tests/instrumentation-counters.test.ts` and mirror it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/vector-stats.test.ts`
Expected: FAIL — `recordVectorUpsert` not exported.

- [ ] **Step 3: Add fields, init, and recorders**

Add to the stats interface (near line 22-26): `vectorUpsertsOk: number; vectorUpsertFailures: number; vectorSearchesOk: number; vectorSearchFailures: number;`. Initialize each to `0` in the reset block (near line 116-120). Add:

```typescript
export function recordVectorUpsert(outcome: 'ok' | 'error'): void {
  if (outcome === 'ok') stats.vectorUpsertsOk++;
  else stats.vectorUpsertFailures++;
}

export function recordVectorSearch(outcome: 'ok' | 'empty' | 'error'): void {
  if (outcome === 'error') stats.vectorSearchFailures++;
  else stats.vectorSearchesOk++;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/vector-stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/stats.ts tests/vector-stats.test.ts
git commit -m "feat(stats): vector upsert/search counters"
```

---

## Task 7: vector-memory orchestrator (singleton + degradation)

**Files:**
- Create: `src/utils/vector-memory.ts`
- Test: `tests/vector-memory.test.ts`

**Interfaces:**
- Consumes: `VectorStore`/types (Task 4), `createInMemoryVectorStore` (Task 4), `createQdrantVectorStore` (Task 5), `vectorPointId` (Task 3), `embedTextForVectorSearch` (existing), `config` (Task 1), `recordVectorUpsert`/`recordVectorSearch` (Task 6).
- Produces:
  - `getVectorStore(): VectorStore | null` — returns the configured singleton (`null` when `VECTOR_STORE=none`); lazily calls `ensureCollection()` once. For tests: `__setVectorStoreForTests(store: VectorStore | null)`.
  - `indexMessage(input: { chatJid: string; refId: string; sender: string; text: string; createdAt: number }): Promise<void>`
  - `indexSession(input: { chatJid: string; refId: string; embeddingInput: string; summaryText: string; createdAt: number; extra?: Record<string, unknown> }): Promise<void>`
  - `indexFact(input: { refId: string; text: string; category: string; createdAt: number }): Promise<void>`
  - `deleteFact(refId: string): Promise<void>`
  - `searchMessages(chatJid: string, query: string, limit: number): Promise<VectorHit[]>` — returns `[]` (never throws) on any failure or when store is null/embedding fails.
  - `searchSessions(chatJid: string, query: string, limit: number): Promise<VectorHit[]>`
  - `searchFacts(query: string, limit: number): Promise<VectorHit[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/vector-memory.test.ts
process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createInMemoryVectorStore } from '../src/utils/vector-store.js';

async function loadModule() {
  vi.resetModules();
  vi.doMock('../src/utils/embedding-provider.js', () => ({
    embedTextForVectorSearch: vi.fn(async (text: string) => ({
      vector: text.includes('weather') ? [1, 0] : [0, 1],
      provider: 'deterministic', model: 'test', latencyMs: 0, usedFallback: false,
    })),
  }));
  return import('../src/utils/vector-memory.js');
}

describe('vector-memory orchestrator', () => {
  it('indexes a fact then retrieves it by semantic query', async () => {
    const mod = await loadModule();
    const store = createInMemoryVectorStore();
    mod.__setVectorStoreForTests(store);
    await mod.indexFact({ refId: '1', text: 'weather is nice', category: 'general', createdAt: 0 });
    const hits = await mod.searchFacts('weather', 3);
    expect(hits.map((h) => h.payload.refId)).toEqual(['1']);
  });

  it('scopes message search to the chat and never throws when store is null', async () => {
    const mod = await loadModule();
    mod.__setVectorStoreForTests(null);
    await expect(mod.searchMessages('g1', 'weather', 3)).resolves.toEqual([]);
    await expect(mod.indexMessage({ chatJid: 'g1', refId: '1', sender: 's', text: 't', createdAt: 0 }))
      .resolves.toBeUndefined();
  });

  it('returns [] when the store search throws (degradation)', async () => {
    const mod = await loadModule();
    mod.__setVectorStoreForTests({
      ensureCollection: async () => {}, upsert: async () => {}, delete: async () => 0,
      health: async () => ({ ok: false }),
      search: async () => { throw new Error('qdrant down'); },
    });
    await expect(mod.searchFacts('weather', 3)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/vector-memory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `vector-memory.ts`**

```typescript
// src/utils/vector-memory.ts
import { config } from './config.js';
import { logger } from '../middleware/logger.js';
import { embedTextForVectorSearch } from './embedding-provider.js';
import { vectorPointId } from './vector-point-id.js';
import { createInMemoryVectorStore, type VectorHit, type VectorStore, type VectorPayload } from './vector-store.js';
import { createQdrantVectorStore } from './qdrant-store.js';
import { recordVectorUpsert, recordVectorSearch } from '../middleware/stats.js';

let store: VectorStore | null | undefined;
let ensured = false;

export function __setVectorStoreForTests(s: VectorStore | null): void {
  store = s;
  ensured = true;
}

export function getVectorStore(): VectorStore | null {
  if (store !== undefined) return store;
  store = config.VECTOR_STORE === 'qdrant' ? createQdrantVectorStore() : null;
  return store;
}

async function ready(): Promise<VectorStore | null> {
  const s = getVectorStore();
  if (s && !ensured) {
    try { await s.ensureCollection(); ensured = true; }
    catch (err) { logger.warn({ err }, 'Qdrant ensureCollection failed; vector memory degraded'); return null; }
  }
  return s;
}

const dims = () => config.VECTOR_EMBEDDING_DIMENSIONS;

/** Embed, or return null so callers fall back to keyword search (never mix spaces). */
async function embed(text: string): Promise<number[] | null> {
  try {
    const r = await embedTextForVectorSearch(text, dims());
    if (r.usedFallback && config.VECTOR_EMBEDDING_PROVIDER === 'openai') return null;
    return r.vector;
  } catch (err) {
    logger.warn({ err }, 'Embedding failed; skipping vector path');
    return null;
  }
}

async function upsertOne(payload: VectorPayload, embeddingInput: string): Promise<void> {
  const s = await ready();
  if (!s) return;
  const vector = await embed(embeddingInput);
  if (!vector) { recordVectorUpsert('error'); return; }
  try {
    await s.upsert([{ id: vectorPointId(payload.kind, payload.refId), vector, payload }]);
    recordVectorUpsert('ok');
  } catch (err) {
    recordVectorUpsert('error');
    logger.warn({ err, kind: payload.kind, refId: payload.refId }, 'Vector upsert failed');
  }
}

export async function indexMessage(input: { chatJid: string; refId: string; sender: string; text: string; createdAt: number }): Promise<void> {
  await upsertOne(
    { kind: 'message', scope: 'chat', chatJid: input.chatJid, refId: input.refId, text: input.text, createdAt: input.createdAt, extra: { sender: input.sender } },
    input.text,
  );
}

export async function indexSession(input: { chatJid: string; refId: string; embeddingInput: string; summaryText: string; createdAt: number; extra?: Record<string, unknown> }): Promise<void> {
  await upsertOne(
    { kind: 'session', scope: 'chat', chatJid: input.chatJid, refId: input.refId, text: input.summaryText, createdAt: input.createdAt, extra: input.extra },
    input.embeddingInput,
  );
}

export async function indexFact(input: { refId: string; text: string; category: string; createdAt: number }): Promise<void> {
  await upsertOne(
    { kind: 'fact', scope: 'global', chatJid: null, refId: input.refId, text: input.text, createdAt: input.createdAt, extra: { category: input.category } },
    input.text,
  );
}

export async function deleteFact(refId: string): Promise<void> {
  const s = await ready();
  if (!s) return;
  try { await s.delete({ kind: 'fact', chatJid: null }); } catch (err) { logger.warn({ err, refId }, 'Vector fact delete failed'); }
}

async function searchKind(query: string, filter: VectorPayload['kind'] extends never ? never : { kind: VectorPayload['kind']; scope?: 'chat' | 'global'; chatJid?: string | null }, limit: number): Promise<VectorHit[]> {
  const s = await ready();
  if (!s || !query.trim()) return [];
  const vector = await embed(query);
  if (!vector) { recordVectorSearch('error'); return []; }
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

export async function searchMessages(chatJid: string, query: string, limit: number): Promise<VectorHit[]> {
  return searchKind(query, { kind: 'message', chatJid }, limit);
}

export async function searchSessions(chatJid: string, query: string, limit: number): Promise<VectorHit[]> {
  return searchKind(query, { kind: 'session', chatJid }, limit);
}

export async function searchFacts(query: string, limit: number): Promise<VectorHit[]> {
  return searchKind(query, { kind: 'fact', scope: 'global' }, limit);
}
```

Note: simplify the `searchKind` filter parameter type to a plain `VectorFilter` import from `vector-store.js` if the conditional type reads awkwardly — the behavior is what the test checks.

- [ ] **Step 4: Run test to verify it passes**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/vector-memory.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full check + commit**

Run: `PATH="$HOME/.local/bin:$PATH" MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npm run check`
Expected: PASS.

```bash
git add src/utils/vector-memory.ts tests/vector-memory.test.ts
git commit -m "feat(vector): vector-memory orchestrator with keyword-fallback degradation"
```

---

## Task 8: Wire ingest — index messages, sessions, and facts

**Files:**
- Modify: `src/middleware/context.ts:59-65` (`recordMessage`)
- Modify: `src/utils/session-summary.ts` (at summary finalization — where `recordSessionSummaryLifecycle('created', ...)` is called)
- Modify: `src/utils/db.ts` (`addMemory`/`deleteMemory` wrappers) or `src/features/memory.ts` write path
- Test: `tests/vector-ingest-wiring.test.ts`

**Interfaces:**
- Consumes: `indexMessage`, `indexSession`, `indexFact`, `deleteFact` from Task 7.
- Produces: side-effect indexing calls fired after each canonical write. Message rows have no numeric id in `DbMessage`; derive `refId` as `${timestamp}:${sender}` (stable per stored message).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/vector-ingest-wiring.test.ts
process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it, vi } from 'vitest';

const indexMessage = vi.fn(async () => {});

async function loadContext() {
  vi.resetModules();
  vi.doMock('../src/utils/vector-memory.js', () => ({
    indexMessage, indexSession: vi.fn(), indexFact: vi.fn(), deleteFact: vi.fn(),
    searchMessages: vi.fn(async () => []), searchSessions: vi.fn(async () => []), searchFacts: vi.fn(async () => []),
  }));
  vi.doMock('../src/utils/db.js', async () => ({
    ...(await vi.importActual<Record<string, unknown>>('../src/utils/db.js')),
    storeMessage: vi.fn(async () => {}),
    getMessages: vi.fn(async () => []),
    searchRelevantMessages: vi.fn(async () => []),
    searchRelevantSessionSummaries: vi.fn(async () => []),
  }));
  return import('../src/middleware/context.js');
}

describe('ingest wiring', () => {
  it('indexes a message vector after recording it', async () => {
    const ctx = await loadContext();
    await ctx.recordMessage('g1@g.us', 's1@s.whatsapp.net', 'is it raining today');
    expect(indexMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatJid: 'g1@g.us', sender: 's1@s.whatsapp.net', text: 'is it raining today',
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/vector-ingest-wiring.test.ts`
Expected: FAIL — `indexMessage` not called.

- [ ] **Step 3: Wire the ingest calls**

In `context.ts` `recordMessage`, after `await storeMessage(...)`:

```typescript
  const createdAt = Math.floor(Date.now() / 1000);
  void indexMessage({ chatJid, refId: `${createdAt}:${sender}`, sender, text, createdAt })
    .catch((err) => logger.warn({ err }, 'message vector index failed'));
```

Add `import { indexMessage } from '../utils/vector-memory.js';`. Use `void` + `.catch` so indexing never blocks or rejects the caller.

In `session-summary.ts`, where a summary is finalized, call `void indexSession({ chatJid, refId: String(sessionId), embeddingInput: buildContextualizedEmbeddingInput(...), summaryText, createdAt: endedAt, extra: { topics: topicTags, timeRange: [startedAt, endedAt] } }).catch(...)`.

In the `addMemory` path (db.ts wrapper or memory.ts), after the row is created: `void indexFact({ refId: String(entry.id), text: entry.fact, category: entry.category, createdAt: entry.created_at }).catch(...)`. In `deleteMemory`, call `void deleteFact(String(id)).catch(...)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/vector-ingest-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full check + commit**

Run: `PATH="$HOME/.local/bin:$PATH" MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npm run check`

```bash
git add src/middleware/context.ts src/utils/session-summary.ts src/utils/db.ts src/features/memory.ts tests/vector-ingest-wiring.test.ts
git commit -m "feat(vector): index messages, sessions, and facts into Qdrant on write"
```

---

## Task 9: Wire retrieval — context pipeline uses vector-memory

**Files:**
- Modify: `src/middleware/context.ts:87-95` (relevant/session retrieval)
- Test: `tests/vector-retrieval-wiring.test.ts`

**Interfaces:**
- Consumes: `searchMessages`, `searchSessions` from Task 7; existing `rerankCandidates`.
- Produces: `formatContext` uses Qdrant hits mapped to `DbMessage`/`SessionSummaryHit` shapes before reranking, and falls back to the existing `searchRelevantMessages`/`searchRelevantSessionSummaries` (keyword) when vector search returns `[]`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/vector-retrieval-wiring.test.ts
process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it, vi } from 'vitest';

const searchMessages = vi.fn(async () => [
  { id: 'm1', score: 0.9, payload: { kind: 'message', scope: 'chat', chatJid: 'g1', refId: '100:s1', text: 'red line is delayed', createdAt: 100, extra: { sender: 's1' } } },
]);
const keywordSearch = vi.fn(async () => []);

async function loadContext() {
  vi.resetModules();
  vi.doMock('../src/utils/vector-memory.js', () => ({
    indexMessage: vi.fn(), indexSession: vi.fn(), indexFact: vi.fn(), deleteFact: vi.fn(),
    searchMessages, searchSessions: vi.fn(async () => []), searchFacts: vi.fn(async () => []),
  }));
  vi.doMock('../src/utils/db.js', async () => ({
    ...(await vi.importActual<Record<string, unknown>>('../src/utils/db.js')),
    storeMessage: vi.fn(async () => {}),
    getMessages: vi.fn(async () => [{ sender: 's9', text: 'hello', timestamp: 999 }]),
    searchRelevantMessages: keywordSearch,
    searchRelevantSessionSummaries: vi.fn(async () => []),
  }));
  return import('../src/middleware/context.js');
}

describe('retrieval wiring', () => {
  it('uses vector hits and does not fall back to keyword when vectors return', async () => {
    const ctx = await loadContext();
    const out = await ctx.formatContext('g1', 'is the red line delayed');
    expect(searchMessages).toHaveBeenCalled();
    expect(out).toContain('red line is delayed');
    expect(keywordSearch).not.toHaveBeenCalled();
  });

  it('falls back to keyword search when vector search returns empty', async () => {
    searchMessages.mockResolvedValueOnce([]);
    const ctx = await loadContext();
    await ctx.formatContext('g1', 'is the red line delayed');
    expect(keywordSearch).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/vector-retrieval-wiring.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement vector-first retrieval with keyword fallback**

In `context.ts`, add a helper that maps a message `VectorHit` to `DbMessage` (`{ sender: String(hit.payload.extra?.sender ?? ''), text: hit.payload.text, timestamp: hit.payload.createdAt }`) and a session `VectorHit` to `SessionSummaryHit` (fields from `payload.extra` + `score: hit.score`). Replace lines 87-95:

```typescript
  const vectorMsgHits = queryText.trim() ? await searchMessages(chatJid, queryText, RELEVANT_COUNT) : [];
  const relevantRaw = vectorMsgHits.length > 0
    ? vectorMsgHits.map(messageHitToDbMessage)
    : (queryText.trim() ? await searchRelevantMessages(chatJid, queryText, RELEVANT_COUNT) : []);
  const relevant = relevantRaw.filter((m) => !recentKeys.has(`${m.timestamp}:${m.sender}:${m.text}`));

  const vectorSessionHits = queryText.trim() ? await searchSessions(chatJid, queryText, SESSION_RELEVANT_COUNT) : [];
  const sessionHits = vectorSessionHits.length > 0
    ? vectorSessionHits.map(sessionHitToSummary)
    : (queryText.trim() ? await searchRelevantSessionSummaries(chatJid, queryText, SESSION_RELEVANT_COUNT) : []);
```

Add `import { searchMessages, searchSessions } from '../utils/vector-memory.js';`. Keep the rest of `formatContext` (reranking/formatting) unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/vector-retrieval-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full check + commit**

Run: `PATH="$HOME/.local/bin:$PATH" MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npm run check`

```bash
git add src/middleware/context.ts tests/vector-retrieval-wiring.test.ts
git commit -m "feat(vector): context retrieval uses Qdrant with keyword fallback"
```

---

## Task 10: Semantic community-fact search in the tool path

**Files:**
- Modify: `src/utils/db.ts` (`searchMemory` wrapper) — add semantic path
- Test: `tests/semantic-memory-search.test.ts`

**Interfaces:**
- Consumes: `searchFacts` from Task 7; existing keyword `searchMemory` (sqlite/pg) as fallback.
- Produces: `searchMemory(keyword, limit)` returns semantic hits (mapped to `MemoryEntry[]`) when Qdrant returns results, else the existing keyword results. The `search_community_memory` tool (via `src/ai/tools.ts`) is unchanged — it already calls `searchMemory`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/semantic-memory-search.test.ts
process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it, vi } from 'vitest';

const searchFacts = vi.fn(async () => [
  { id: 'fact:3', score: 0.8, payload: { kind: 'fact', scope: 'global', chatJid: null, refId: '3', text: 'Trivia night is Wednesdays at Parlor', createdAt: 0, extra: { category: 'venues' } } },
]);
const keywordSearchMemory = vi.fn(async () => [] as unknown[]);

async function loadDb() {
  vi.resetModules();
  vi.doMock('../src/utils/vector-memory.js', () => ({ searchFacts, indexFact: vi.fn(), deleteFact: vi.fn() }));
  // Point the underlying backend's keyword searchMemory at our spy per the db module's backend seam.
  return import('../src/utils/db.js');
}

describe('semantic memory search', () => {
  it('returns semantic fact hits mapped to MemoryEntry when available', async () => {
    const db = await loadDb();
    const results = await db.searchMemory('board game night');
    expect(searchFacts).toHaveBeenCalled();
    expect(results[0].fact).toContain('Trivia night');
    expect(results[0].category).toBe('venues');
  });
});
```

(Adjust the backend seam mock to however `db.ts` selects sqlite/pg — check the existing `tests/db-shared-layer.test.ts` for the established pattern and mirror it so the keyword path is stubbed.)

- [ ] **Step 2: Run test to verify it fails**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/semantic-memory-search.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the semantic path to `searchMemory`**

In `db.ts`, wrap the backend `searchMemory`:

```typescript
export async function searchMemory(keyword: string, limit = 10): Promise<MemoryEntry[]> {
  const { searchFacts } = await import('./vector-memory.js');
  const hits = await searchFacts(keyword, limit);
  if (hits.length > 0) {
    return hits.map((h) => ({
      id: Number(h.payload.refId),
      fact: h.payload.text,
      category: String(h.payload.extra?.category ?? 'general'),
      source: 'auto',
      created_at: h.payload.createdAt,
    }));
  }
  return backend.searchMemory(keyword, limit); // existing keyword fallback
}
```

Match `db.ts`'s actual backend accessor name for the fallback call.

- [ ] **Step 4: Run test to verify it passes**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/semantic-memory-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full check + commit**

Run: `PATH="$HOME/.local/bin:$PATH" MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npm run check`

```bash
git add src/utils/db.ts tests/semantic-memory-search.test.ts
git commit -m "feat(vector): semantic community-fact search with keyword fallback"
```

---

## Task 11: Resumable backfill + CLI

**Files:**
- Create: `src/utils/vector-backfill.ts`
- Create: `scripts/backfill-vectors.mjs`
- Modify: `package.json` (add `"backfill:vectors": "node scripts/backfill-vectors.mjs"`)
- Test: `tests/vector-backfill.test.ts`

**Interfaces:**
- Consumes: `getAllMemories`, `getMessages` (per chat), session listing from `db.ts`; `indexFact`/`indexMessage`/`indexSession` from Task 7.
- Produces: `backfillVectors(opts?: { batchSize?: number; batchDelayMs?: number; missingOnly?: boolean; onProgress?: (p: BackfillProgress) => void }): Promise<BackfillProgress>` where `BackfillProgress` = `{ total; processed; succeeded; failed; skipped; elapsedMs }`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/vector-backfill.test.ts
process.env.MESSAGING_PLATFORM ??= 'whatsapp';
process.env.OWNER_JID ??= 'test_owner@s.whatsapp.net';
process.env.OPENROUTER_API_KEY ??= 'test_key_ci';
process.env.AI_PROVIDER_ORDER ??= 'openrouter';

import { describe, expect, it, vi } from 'vitest';

const indexFact = vi.fn(async () => {});

async function loadBackfill() {
  vi.resetModules();
  vi.doMock('../src/utils/vector-memory.js', () => ({ indexFact, indexMessage: vi.fn(), indexSession: vi.fn() }));
  vi.doMock('../src/utils/db.js', async () => ({
    ...(await vi.importActual<Record<string, unknown>>('../src/utils/db.js')),
    getAllMemories: vi.fn(async () => [
      { id: 1, fact: 'Founded in 2024', category: 'general', source: 'owner', created_at: 10 },
      { id: 2, fact: 'Trivia Wednesdays', category: 'venues', source: 'owner', created_at: 20 },
    ]),
  }));
  return import('../src/utils/vector-backfill.js');
}

describe('vector backfill', () => {
  it('re-indexes all facts and reports progress', async () => {
    const mod = await loadBackfill();
    const progress = await mod.backfillVectors({ batchSize: 1, batchDelayMs: 0 });
    expect(indexFact).toHaveBeenCalledTimes(2);
    expect(progress.succeeded).toBe(2);
    expect(progress.failed).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/vector-backfill.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `vector-backfill.ts`**

Iterate facts (from `getAllMemories`), then messages/sessions per chat, calling the Task-7 index functions, batching with `batchDelayMs` between batches (mirror `session-backfill.ts` structure). Count succeeded/failed/skipped into `BackfillProgress`; call `onProgress` after each batch. Facts are the required minimum for the test; message/session backfill follows the same loop. Then create `scripts/backfill-vectors.mjs`:

```javascript
import { backfillVectors } from '../dist/utils/vector-backfill.js';
const p = await backfillVectors({ onProgress: (x) => console.log(JSON.stringify(x)) });
console.log('Backfill complete:', JSON.stringify(p));
```

Add the npm script to `package.json`.

- [ ] **Step 4: Run test to verify it passes**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/vector-backfill.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full check + commit**

Run: `PATH="$HOME/.local/bin:$PATH" MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npm run check`

```bash
git add src/utils/vector-backfill.ts scripts/backfill-vectors.mjs package.json tests/vector-backfill.test.ts
git commit -m "feat(vector): resumable Qdrant backfill + backfill:vectors CLI"
```

---

## Task 12: CI Qdrant service + integration test

**Files:**
- Modify: `.github/workflows/ci.yml` (add a job or service container)
- Create: `tests/vector-memory-integration.test.ts`

**Interfaces:**
- Consumes: `createQdrantVectorStore` (Task 5) against a live `qdrant/qdrant` container.
- Produces: an integration test gated on `QDRANT_URL` being set (skips locally when absent, runs in CI).

- [ ] **Step 1: Write the failing (skip-guarded) test**

```typescript
// tests/vector-memory-integration.test.ts
import { describe, expect, it } from 'vitest';
import { createQdrantVectorStore } from '../src/utils/qdrant-store.js';

const RUN = !!process.env.QDRANT_URL;

describe.skipIf(!RUN)('qdrant integration', () => {
  it('round-trips ensureCollection → upsert → search → delete', async () => {
    const store = createQdrantVectorStore();
    await store.ensureCollection();
    const dims = Number(process.env.VECTOR_EMBEDDING_DIMENSIONS ?? 1536);
    const vec = Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0));
    await store.upsert([{ id: '00000000-0000-5000-8000-000000000001', vector: vec,
      payload: { kind: 'fact', scope: 'global', chatJid: null, refId: 'itest', text: 'integration', createdAt: 0 } }]);
    const hits = await store.search(vec, { limit: 1, filter: { kind: 'fact' } });
    expect(hits[0]?.payload.refId).toBe('itest');
    await store.delete({ kind: 'fact' });
  });
});
```

- [ ] **Step 2: Run test to verify it skips locally**

Run: `npx vitest run tests/vector-memory-integration.test.ts`
Expected: SKIPPED (no `QDRANT_URL`).

- [ ] **Step 3: Add the Qdrant service + env to CI**

In `.github/workflows/ci.yml`, add to the quality-gate job (or a dedicated `vector` job mirroring the Postgres job at lines ~52-96) a service:

```yaml
    services:
      qdrant:
        image: qdrant/qdrant:latest
        ports: ['6333:6333']
        options: >-
          --health-cmd "bash -c ':> /dev/tcp/127.0.0.1/6333'"
          --health-interval 10s --health-timeout 5s --health-retries 5
```

and set `QDRANT_URL: http://127.0.0.1:6333`, `VECTOR_EMBEDDING_PROVIDER: deterministic`, `VECTOR_EMBEDDING_DIMENSIONS: 256` in that job's env so the integration test runs without an OpenAI key.

- [ ] **Step 4: Verify the test passes in CI**

Push the branch; confirm the Quality Gate job runs the integration test green (it exercises the real container). Locally it stays skipped.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml tests/vector-memory-integration.test.ts
git commit -m "test(vector): CI Qdrant service + round-trip integration test"
```

---

## Task 13: Eval-harness guard against retrieval regression

**Files:**
- Create: `tests/vector-eval-guard.test.ts`
- Reference: `src/utils/eval-retrieval.ts` (`DEFAULT_EVAL_SET`, `runEvaluation`), Task 4 fake store

**Interfaces:**
- Consumes: `createInMemoryVectorStore` (Task 4), `vector-memory` (Task 7), `DEFAULT_EVAL_SET` (existing).
- Produces: a test asserting recall@k through the vector-memory + fake-store path meets the same baseline the existing `eval-retrieval.test.ts` asserts (`meanRecallAtK >= 0.7`).

- [ ] **Step 1: Write the test**

Load `vector-memory`, inject `createInMemoryVectorStore()`, index the eval set's synthetic evidence via `indexMessage`/`indexSession`, run `searchMessages`/`searchSessions` for each eval query, feed through `rerankCandidates`, and compute recall the same way `runEvaluation` does. Assert `meanRecallAtK >= 0.7`. Use a deterministic embedding mock (as in Task 7's test) so the run is stable.

```typescript
// tests/vector-eval-guard.test.ts — assertion shape
expect(summary.meanRecallAtK).toBeGreaterThanOrEqual(0.7);
```

- [ ] **Step 2: Run test to verify it passes**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/vector-eval-guard.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/vector-eval-guard.test.ts
git commit -m "test(vector): recall@k regression guard through vector-memory path"
```

---

## Task 14: Remove pgvector path + health surfacing + docs

**Files:**
- Modify: `src/utils/db-postgres.ts` (remove `message_vectors`/`conversation_session_vectors` create at :228-256, upsert at :344/:581, delete at :444/:587, search at :611/:671; `searchRelevantMessages`/`searchRelevantSessionSummaries` return keyword-only or `[]`)
- Modify: `src/utils/session-backfill.ts` — delete (superseded by `vector-backfill.ts`) and remove references
- Modify: `src/middleware/health.ts` — add Qdrant reachability to the health/metrics payload
- Modify: `AGENTS.md` — decisions-log entry
- Test: `tests/pgvector-removed.test.ts`, `tests/health-qdrant.test.ts`

**Interfaces:**
- Consumes: `getVectorStore().health()` (Task 7/4).
- Produces: no `message_vectors`/`conversation_session_vectors` DDL remains; `/health` includes `vectorStore: { ok: boolean }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/pgvector-removed.test.ts
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

describe('pgvector path removed', () => {
  it('db-postgres.ts no longer references vector tables', () => {
    const src = readFileSync('src/utils/db-postgres.ts', 'utf-8');
    expect(src).not.toMatch(/message_vectors/);
    expect(src).not.toMatch(/conversation_session_vectors/);
  });
});
```

```typescript
// tests/health-qdrant.test.ts — assert the health payload builder includes vectorStore.ok
// (mirror the structure of the existing tests/health-auth.test.ts / health wiring tests)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/pgvector-removed.test.ts tests/health-qdrant.test.ts`
Expected: FAIL.

- [ ] **Step 3: Remove pgvector code and add health surfacing**

Delete the vector-table DDL, upsert, delete, and search SQL from `db-postgres.ts`; make `searchRelevantMessages`/`searchRelevantSessionSummaries` there return the keyword implementation (or `[]`) so callers still resolve. Delete `src/utils/session-backfill.ts` and its test `tests/session-backfill.test.ts`, plus any imports. Add `vectorStore: { ok }` (from `await getVectorStore()?.health() ?? { ok: false }`, guarded) to the health/metrics payload in `health.ts`. Add to `AGENTS.md` Decisions Log:

```markdown
- **Vector memory: self-hosted Qdrant is the single vector store** (2026-07-03). Relational DB is source of record; all embeddings live in Qdrant (`garbanzo_memory`). pgvector removed. Semantic search works in SQLite deployments. `VECTOR_STORE=none` = keyword-only. Embeddings: OpenAI `text-embedding-3-small` @ 1536; deterministic is tests/offline only and never mixed into a live collection.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npx vitest run tests/pgvector-removed.test.ts tests/health-qdrant.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check + commit**

Run: `PATH="$HOME/.local/bin:$PATH" MESSAGING_PLATFORM=whatsapp OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter npm run check`
Expected: PASS (full suite, including the Postgres backend test job when run in CI).

```bash
git add src/utils/db-postgres.ts src/middleware/health.ts AGENTS.md tests/pgvector-removed.test.ts tests/health-qdrant.test.ts
git rm src/utils/session-backfill.ts tests/session-backfill.test.ts
git commit -m "refactor(vector): remove pgvector path, surface Qdrant health, log decision"
```

---

## Task 15: PR

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/qdrant-memory-rag
```

- [ ] **Step 2: Open PR with body summarizing the design + rollout**

Use `gh pr create` referencing the spec, the single-vector-store cutover, the `VECTOR_STORE=none` rollback, and the required post-deploy `npm run backfill:vectors`. Note the owner-approved new dependency. Do NOT merge — owner merges. Update the PR description on every subsequent push.

---

## Self-Review

**Spec coverage:**
- Self-hosted Qdrant single store → Tasks 2, 5, 14. ✓
- VectorStore interface + QdrantVectorStore + vector-memory orchestrator → Tasks 4, 5, 7. ✓
- All three memory layers (message/session/fact) indexed + retrieved → Tasks 8, 9, 10. ✓
- Semantic community facts (was keyword) → Task 10. ✓
- OpenAI embeddings default + no space-mixing degradation → Tasks 1, 7. ✓
- Reuse reranker + eval harness → Tasks 9, 13. ✓
- Degradation/error handling (Qdrant down, embedding fail, `none` mode) → Tasks 7, 9, 10. ✓
- Resumable backfill + CLI → Task 11. ✓
- Config keys + `.env.example` + compose + CI → Tasks 1, 2, 12. ✓
- Health/metrics surfacing → Tasks 6, 14. ✓
- pgvector removal → Task 14. ✓
- Phased rollout ending in removal → task order (ingest/retrieve wired before removal; `VECTOR_STORE` flag for rollback). ✓

**Placeholder scan:** Tasks 10, 13, 14 defer some test-body/removal detail to "mirror the existing pattern in `<named file>`" rather than inlining every line — these point at a specific existing file to copy, not a vague TODO. All code steps that introduce new behavior show the code.

**Type consistency:** `VectorKind`/`VectorScope`/`VectorPayload`/`VectorPoint`/`VectorHit`/`VectorFilter`/`VectorSearchOpts`/`VectorStore` defined in Task 4 and used consistently in Tasks 5, 7. `vectorPointId(kind, refId)` (Task 3) called in Task 7. `BackfillProgress` fields match `session-backfill.ts`'s existing shape. Index/search function signatures in Task 7's Produces block match their call sites in Tasks 8–11.
```
