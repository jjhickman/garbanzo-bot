# Qdrant Memory RAG — Design Spec

**Date:** 2026-07-03
**Status:** Draft — pending owner review
**Branch:** `feat/qdrant-memory-rag`

## Summary

Replace garbanzo-bot's Postgres-only `pgvector` retrieval with a **dedicated self-hosted Qdrant vector store** that serves all semantic memory — recent messages, conversation-session summaries, and curated community facts — regardless of whether the relational database is SQLite or Postgres.

Today, semantic search only works when the backend is Postgres with pgvector; the default SQLite deployment silently degrades to keyword matching, and a deterministic hash stands in for real embeddings. This makes "memory" a second-class feature in the shipping configuration. Qdrant becomes the single source of truth for vectors; the relational DB remains the system of record for the canonical rows.

## Goals

1. Semantic retrieval works in **every** deployment (SQLite and Postgres), not just Postgres.
2. **One** vector code path. Remove the pgvector tables and query code — no dual-backend maintenance.
3. Community facts (currently keyword-only) gain semantic retrieval — the biggest user-visible win.
4. Real embeddings by default (OpenAI `text-embedding-3-small`), with graceful degradation when the embedding provider or Qdrant is unavailable.
5. Reuse the existing reranker (`src/utils/reranker.ts`) and offline eval harness (`src/utils/eval-retrieval.ts`) unchanged in spirit.
6. Reversible rollout: a config flag returns the bot to keyword-only behavior; a backfill job re-indexes existing data.

## Non-goals

- No GraphRAG, no HyDE, no hierarchical weekly rollups (these remain future `VECTOR_DB_PLAN.md` Phase 3 ideas).
- No change to how sessions are detected or summarized (`session-summary.ts` stays as-is; only the vector read/write target changes).
- No managed cloud vector DB and no turnkey RAG API — decided against in brainstorming (self-hosted, data stays on our infra).
- No change to the relational schema for canonical rows (messages, `conversation_sessions`, `memories` tables stay).

## Decisions (from brainstorming)

- **Hosting:** self-hosted Qdrant in Docker, colocated with the bot (Pi 5 or companion host). No per-query cost; community message content never leaves our infrastructure.
- **Cutover:** Qdrant is the *only* vector store. The pgvector path (`message_vectors`, `conversation_session_vectors`, their HNSW indexes and query code) is removed after backfill is verified.
  - *(Owner selected "Self-hosted Qdrant". The cutover question timed out; this spec proceeds on the recommended single-store cutover, matching the "more than a compromise" requirement. Flag for confirmation.)*
- **Embeddings:** OpenAI `text-embedding-3-small` at **1536 dims** by default. Deterministic hash embedding is retained for tests and offline/local-only mode, never mixed with real vectors in the same collection at runtime.

## Architecture

```
                         ┌─────────────────────────────┐
   inbound message ─────▶│ relational DB (SQLite/PG)    │  ← system of record
   (hot path)            │  messages, sessions, memories │    (canonical rows)
                         └──────────────┬──────────────┘
                                        │ async, best-effort
                                        ▼
                         ┌─────────────────────────────┐
   query (formatContext, │      VectorMemory (new)      │  orchestrates embed + upsert/search
   search tool) ────────▶│  src/utils/vector-memory.ts  │
                         └───────┬─────────────┬────────┘
                                 │             │
                    embedTextForVectorSearch   │  VectorStore interface
                   (embedding-provider.ts)     │  src/utils/vector-store.ts
                                               ▼
                                   ┌───────────────────────┐
                                   │  QdrantVectorStore     │  @qdrant/js-client-rest
                                   │  src/utils/qdrant-store.ts │
                                   └───────────┬───────────┘
                                               ▼
                                        Qdrant (Docker)
                                    collection: garbanzo_memory
```

### Units and boundaries

Each unit has one job, a defined interface, and is testable in isolation.

- **`src/utils/vector-store.ts`** — `VectorStore` interface + point/payload/filter types. No Qdrant specifics. Depends on nothing.
  - `ensureCollection(): Promise<void>` — idempotent create with the configured dims + cosine distance.
  - `upsert(points: VectorPoint[]): Promise<void>`
  - `search(vector: number[], opts: VectorSearchOpts): Promise<VectorHit[]>` — `opts` carries `limit`, `filter` (by `chatJid`, `kind`, `scope`).
  - `delete(filter: VectorFilter): Promise<number>`
  - `health(): Promise<{ ok: boolean; detail?: string }>`
- **`src/utils/qdrant-store.ts`** — `QdrantVectorStore implements VectorStore` using `@qdrant/js-client-rest`. Translates our filter model to Qdrant filter JSON. The only file that imports the Qdrant client.
- **`src/utils/vector-memory.ts`** — orchestration the features call. Embeds text once via `embedTextForVectorSearch`, builds points/queries, applies degradation policy, records metrics. Holds no HTTP or SQL. This replaces the vector logic currently living inside the DB backends.
- **`src/utils/embedding-provider.ts`** — unchanged interface; default flips to `openai`/1536 via config. Deterministic remains for tests/offline.
- **`src/utils/reranker.ts`, `src/utils/eval-retrieval.ts`** — reused as-is; the eval harness is re-pointed at `vector-memory` in tests.

### Collection model

Single collection `garbanzo_memory` (configurable via `QDRANT_COLLECTION`). One HNSW index, one place to operate. Points carry a payload for filtering rather than splitting into per-kind collections:

| payload field | type | purpose |
|---|---|---|
| `kind` | `"message" \| "session" \| "fact"` | filter/route by memory type |
| `scope` | `"chat" \| "global"` | facts are `global`; messages/sessions are `chat` |
| `chatJid` | string \| null | tenant isolation per group (null for global facts) |
| `refId` | string | id back to the canonical row (`messageId`, `sessionId`, `memoryId`) |
| `text` | string | snippet returned for reranking/formatting (bounded) |
| `createdAt` | number | recency decay in the reranker |
| `extra` | object | kind-specific: session `topics`/`timeRange`, fact `category`, message `sender` |

Point id: deterministic UUIDv5-style derivation from `kind:refId` so re-upserts are idempotent and deletes are targetable. Retrieval always filters by `scope`/`chatJid` first (cheap payload filter), then vector-ranks.

## Data flow

### Ingest (write) — always async, never blocks a reply

1. **Message:** existing `storeMessage()` writes the row (unchanged). A new best-effort call enqueues `vectorMemory.indexMessage(...)` → embed → `upsert` one `kind:"message"` point. Failure logs a metric and drops; the canonical row is safe.
2. **Session summary:** when `session-summary.ts` finalizes a summary, call `vectorMemory.indexSession(...)` with the contextualized embedding input already built by `buildContextualizedEmbeddingInput` → upsert one `kind:"session"` point.
3. **Fact:** `addMemory()` writes the row, then `vectorMemory.indexFact(...)` → upsert one `kind:"fact", scope:"global"` point. `deleteMemory()` also deletes the point by `refId`.

### Retrieve (read)

- **`formatContext()`** (`src/middleware/context.ts`): embed the query once, then `vectorMemory.searchContext(chatJid, queryVector)` returns message + session hits (filtered by `chatJid`), fed into the **existing reranker** exactly as today. Verbatim recent-message window is unchanged.
- **`search_community_memory` tool** (`src/utils/db.ts` `searchMemory`): gains a semantic path — embed the keyword, `search` with `kind:"fact", scope:"global"`. Keyword LIKE search becomes the fallback when Qdrant/embeddings are unavailable.

## Degradation and error handling

Priority: never block or crash a reply. Explicit, tested fallbacks:

| Failure | Behavior |
|---|---|
| Qdrant unreachable (read) | `search` returns `[]`; retrieval uses the verbatim recent-message window; `searchMemory` falls back to relational keyword LIKE. Logged + metric. |
| Qdrant unreachable (write) | Upsert dropped, counted (`vectorUpsertFailures`). Backfill can re-index later. Canonical row already persisted. |
| Embedding provider fails/times out | Skip the vector path for that call and use keyword fallback. **Do not** silently substitute a deterministic vector into a collection built from OpenAI vectors (mixing spaces corrupts ranking). |
| `VECTOR_STORE=none` | No Qdrant client constructed; keyword-only everywhere (minimal local mode). |
| Dimension/model mismatch on startup | `ensureCollection` detects an existing collection with different dims and refuses to write, logging a clear "run backfill after changing model/dims" error. |

Health: `/health` (and metrics) surface Qdrant reachability and last upsert-failure counters so a broken vector store is visible, not silent.

## Migration / backfill

- Generalize the existing `src/utils/session-backfill.ts` into `src/utils/vector-backfill.ts`: iterate messages (recent window), summarized sessions, and all facts; embed and upsert into Qdrant. Rate-limited, resumable, `missing-only` mode (skips points already present). Progress logged.
- Exposed as an owner/ops command or npm script (`npm run backfill:vectors`), run once on deploy of this feature.
- **Removal (after backfill verified):** drop `message_vectors` and `conversation_session_vectors` creation/query/delete code from `db-postgres.ts`; remove the pgvector branch from `searchRelevantMessages`/`searchRelevantSessionSummaries` in both backends (they now delegate to `vector-memory` or return the keyword fallback). A Postgres migration note documents that the tables are safe to drop; we `DROP TABLE IF EXISTS` them in the init path guarded by a one-time flag, or leave them dormant and documented. **Open question below.**

## Configuration

New keys in `src/utils/config.ts` (Zod-validated, documented in `.env.example`):

- `VECTOR_STORE`: `qdrant | none` (default `qdrant`; `none` = keyword-only).
- `QDRANT_URL`: default `http://qdrant:6333` (compose service name).
- `QDRANT_API_KEY`: optional (empty for local; set for hardened deployments).
- `QDRANT_COLLECTION`: default `garbanzo_memory`.

Changed defaults (existing keys):

- `VECTOR_EMBEDDING_PROVIDER`: default `deterministic` → **`openai`** (deterministic remains valid for tests/offline).
- New `VECTOR_EMBEDDING_DIMENSIONS`: default `1536` (Qdrant collection dims must match).

Removed/retired: pgvector-specific behavior keys, if any, and the implicit "pgvector only when Postgres" branch.

`docker-compose*.yml`: add a `qdrant` service (`qdrant/qdrant` image, named volume `qdrant_data:/qdrant/storage`, health check) to dev/prod/aws variants. Adding the `@qdrant/js-client-rest` dependency requires owner approval per AGENTS.md ("Ask First: adding new npm dependencies").

## Testing

- **Unit:** `VectorStore` contract tests run against an in-memory fake implementing the interface — covers `vector-memory` orchestration, filter building, and every degradation branch without a live Qdrant.
- **Filter/payload mapping:** `qdrant-store` translation to Qdrant filter JSON tested in isolation.
- **Integration (CI):** add a `qdrant/qdrant` service container to the CI job (mirroring the existing Postgres backend job) — round-trip `ensureCollection` → `upsert` → `search` → `delete`, plus backfill against a seeded relational DB.
- **Retrieval quality:** re-point the offline eval harness (`eval-retrieval.ts`) at `vector-memory` + fake/real store; assert recall@k does not regress versus the recorded baseline.
- **Degradation:** tests that Qdrant-down and embedding-failure paths return keyword results and never throw into the reply path.
- **Regression:** existing 723-test suite stays green; no added latency in the hot ingest path (vector work is async/awaited off the reply path).

## Rollout

1. Land interface + `QdrantVectorStore` + `vector-memory` behind `VECTOR_STORE`, plus compose service and config — no read/write wired yet.
2. Wire ingest and run backfill in a canary deployment. During this step only, pgvector writes remain so a rollback keeps working — this is a **transient** migration state, removed in step 4, not a maintained dual-backend.
3. Switch reads to `vector-memory`; validate recall/latency against pgvector via the eval harness.
4. Remove pgvector code + tables once reads are stable.
5. Rollback at any step: `VECTOR_STORE=none` (keyword-only) or revert the read switch.

## Open questions for owner review

1. **Cutover confirmation** — proceed removing pgvector entirely (this spec), or keep it coexisting behind a flag? (Recommended: remove.)
2. **Embedding dims** — `1536` (full `text-embedding-3-small`, best quality, trivial storage at this scale) vs a reduced `512`/`768` (cheaper storage, marginal quality loss). Recommended: `1536`.
3. **pgvector table teardown** — actively `DROP TABLE` in the Postgres init path, or leave the tables dormant + documented and remove only the code? (Recommended: leave dormant one release, drop the next — reversible.)
4. **Qdrant placement** — same Pi 5 as the bot (simplest; ~200–400 MB RAM), or a companion host? (Recommended: same host to start; the client URL makes moving it a config change.)
```
