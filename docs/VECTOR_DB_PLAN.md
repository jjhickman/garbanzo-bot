# Vector DB Plan (pgvector now, Qdrant-ready)
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


## Goal

Ship semantic retrieval in production immediately with Postgres + pgvector, while keeping a clean migration path to Qdrant if retrieval scale/latency/filtering needs grow.

## Phase A (active): pgvector primary

- Keep Postgres as system of record for messages and embeddings.
- Use semantic retrieval for context selection and memory lookup.
- Maintain sqlite keyword fallback for local/non-Postgres modes.
- Keep bounded token budgets and context compression in prompt assembly.

## Phase B: Qdrant-ready abstraction

- Introduce a `VectorStore` interface with:
  - `upsertMessageEmbedding`
  - `searchSimilarMessages`
  - `deleteExpiredEmbeddings`
- Implement `PgvectorStore` first (default).
- Add `QdrantStore` behind a feature flag (disabled by default).

## Phase C: dual-write / A-B validation

- Optional dual-write mode:
  - write to pgvector (primary)
  - mirror writes to Qdrant
- Read path switch options:
  - `VECTOR_READ_BACKEND=pgvector|qdrant`
- Add metrics for:
  - retrieval latency p50/p95
  - top-k hit overlap (pgvector vs qdrant)
  - downstream response quality proxy metrics

## Phase D: cutover criteria

Cut over reads to Qdrant only when all are true for a sustained window:

- p95 retrieval latency improves materially
- relevance overlap is acceptable for target prompts
- operational reliability is equal or better
- cost profile is acceptable

## Guardrails

- Never remove pgvector write path until Qdrant read path is stable in production.
- Keep feature flags reversible at runtime config level.
- Keep the Postgres table as canonical backup source for re-index/re-hydration.
