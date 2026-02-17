# Vector Memory Implementation Spec
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo

## Why this spec exists

We already have:

- message persistence in sqlite/postgres,
- prompt-time context compression (`src/middleware/context.ts`),
- postgres pgvector table for message retrieval (`message_vectors`),
- fallback keyword retrieval when vector is unavailable.

But we do not yet have durable conversation-level memory beyond raw message windows.
This spec adds a practical, low-cost path to stronger memory quality by indexing summarized conversation sessions.

## External research considered

This design is informed by:

- NirDiamant/RAG_Techniques (broad practical catalog),
- RAPTOR (tree/hierarchical abstraction improves long-context retrieval),
- HyDE (query transformation can improve hard query recall),
- Anthropic Contextual Retrieval (contextualized chunks reduce retrieval failures),
- LangChain contextual compression (post-retrieval query-focused reduction),
- MemGPT / Generative Agents memory patterns (multi-tier memory, recency-aware retrieval).

## Product goals

1. Improve long-horizon memory retrieval for group chat.
2. Keep runtime costs low and predictable.
3. Preserve current behavior for sqlite/local users.
4. Add reversible feature flags for safe rollout.
5. Keep retrieval explainable and testable.

## Non-goals (Phase 1)

- No GraphRAG in Phase 1.
- No external vector DB migration in Phase 1.
- No forced dependency additions.
- No always-on expensive LLM post-processing of every turn.

## Current architecture constraints

- `recordMessage()` is in the hot path (`src/core/process-inbound-message.ts`).
- Context assembly happens in `formatContext()` (`src/middleware/context.ts`).
- DB backend is abstracted behind `DbBackend` (`src/utils/db-backend.ts`).
- Postgres can use pgvector; sqlite cannot.
- Current embedding helper is deterministic hash-based (`src/utils/text-embedding.ts`).

## Proposed memory model

Use a two-tier retrieval model for chat memory:

1. Raw message memory (existing):
   - recent verbatim messages,
   - direct message-level relevance retrieval.

2. Session memory (new):
   - conversation sessions split by inactivity gaps,
   - LLM-generated summary per closed session,
   - summary embedding for semantic retrieval,
   - references back to source time range.

This gives better long-range recall while keeping prompt budgets bounded.

## Phase plan

## Phase 1 (target next): Session summaries + retrieval

### 1) Sessionization

Define a session as consecutive messages in a chat where no inactivity gap exceeds `CONTEXT_SESSION_GAP_MINUTES`.

Default:

- `CONTEXT_SESSION_GAP_MINUTES=30`

Rules:

- Session key scope: `chat_jid` (not global user).
- New message within gap: append to current open session.
- New message after gap: close prior session, open new session.

### 2) Data model changes

Add session tables in both backends.

Postgres:

- `conversation_sessions`
  - `id BIGSERIAL PRIMARY KEY`
  - `chat_jid TEXT NOT NULL`
  - `started_at BIGINT NOT NULL`
  - `ended_at BIGINT NOT NULL`
  - `message_count INTEGER NOT NULL`
  - `participants JSONB NOT NULL DEFAULT '[]'::jsonb`
  - `summary_text TEXT`
  - `topic_tags JSONB NOT NULL DEFAULT '[]'::jsonb`
  - `action_items JSONB NOT NULL DEFAULT '[]'::jsonb`
  - `entities JSONB NOT NULL DEFAULT '[]'::jsonb`
  - `summary_model TEXT`
  - `summary_version INTEGER NOT NULL DEFAULT 1`
  - `summary_created_at BIGINT`
  - `status TEXT NOT NULL` (`open|closed|summarized|failed`)
- indexes:
  - `(chat_jid, ended_at DESC)`
  - `(chat_jid, status)`

- `conversation_session_vectors` (if pgvector enabled)
  - `session_id BIGINT PRIMARY KEY REFERENCES conversation_sessions(id) ON DELETE CASCADE`
  - `chat_jid TEXT NOT NULL`
  - `embedding vector(256) NOT NULL`
  - index: hnsw cosine

SQLite:

- `conversation_sessions`
  - similar logical fields, JSON stored as TEXT.
- keyword lookup on `summary_text` as fallback.

### 3) Summarization payload

For each closed session, generate a compact JSON summary:

- `summary`: 3-6 bullet style sentences worth of text (plain text output),
- `topics`: list of short tags,
- `decisions`: explicit decisions/agreements,
- `open_questions`: unresolved asks,
- `entities`: place/people/tools mentioned.

Store:

- structured arrays in columns,
- flattened summary text for retrieval.

### 4) Summarization execution model

Cost-aware approach:

- summarize only closed sessions,
- skip sessions with `< CONTEXT_SESSION_MIN_MESSAGES` (default `4`),
- skip if already summarized with same version,
- cap input by token/message limits.

Execution path:

- message ingest marks sessions closed/open,
- async summarization worker processes pending closed sessions,
- worker is best-effort and never blocks message reply path.

### 5) Retrieval changes in `formatContext()`

Keep existing behavior and add session retrieval block.

New retrieval blend:

1. recent verbatim messages (existing),
2. message-level relevant hits (existing),
3. session-level relevant summaries (new).

Ranking for session summaries:

- semantic score (vector similarity where available),
- recency decay bonus,
- keyword overlap tie-break.

Context output format:

- `Relevant earlier session summaries:`
  - include short summary,
  - include time window,
  - include top topics.

Prompt budget controls:

- max session summaries per query: default `3`,
- max chars per summary snippet: default `420`.

### 6) Embedding strategy in Phase 1

To stay cheap and ship quickly:

- reuse existing deterministic embedding helper for session summaries first,
- keep interface ready to swap to provider embeddings later,
- do not require external API embedding calls in initial rollout.

Rationale:

- immediate quality gains come from session summarization itself,
- deterministic embedding avoids ingest cost spikes,
- allows safe production rollout before paid embedding cutover.

### 7) New config flags

Add to `src/utils/config.ts`:

- `CONTEXT_SESSION_MEMORY_ENABLED` (default `true`)
- `CONTEXT_SESSION_GAP_MINUTES` (default `30`)
- `CONTEXT_SESSION_MIN_MESSAGES` (default `4`)
- `CONTEXT_SESSION_MAX_RETRIEVED` (default `3`)
- `CONTEXT_SESSION_SUMMARY_MODEL` (default `gpt-4.1-mini` style value; used once LLM summarizer is on)
- `CONTEXT_SESSION_SUMMARY_VERSION` (default `1`)

Optional guardrail:

- `CONTEXT_SESSION_SUMMARIZATION_ENABLED` (default `true` in cloud, `false` local if desired).

### 8) Backend API changes

Extend `DbBackend` with session memory methods:

- `upsertSessionOnMessage(chatJid, sender, text, timestamp): Promise<void>`
- `listPendingSessionSummaries(limit?: number): Promise<SessionRecord[]>`
- `saveSessionSummary(sessionId, payload): Promise<void>`
- `markSessionSummaryFailed(sessionId, reason): Promise<void>`
- `searchRelevantSessionSummaries(chatJid, query, limit?: number): Promise<SessionSummaryHit[]>`

And wire through `src/utils/db.ts`.

### 9) Observability

Add logs/metrics:

- session lifecycle events (opened/closed/summarized),
- summarization latency + failures,
- retrieved session count per request,
- context token/char contribution by source (recent/message/session).

Daily counters:

- `sessionSummariesCreated`
- `sessionSummaryFailures`
- `sessionSummarySkippedSmall`

### 10) Tests

Unit tests:

- session splitting at 30-minute boundary,
- participant and count tracking,
- retrieval ranking and dedupe,
- summary persistence and versioning,
- sqlite fallback search behavior.

Integration tests:

- context assembly includes session summaries when enabled,
- disabled flag returns existing behavior unchanged,
- postgres with pgvector and without pgvector both work.

Regression:

- no added reply latency in normal hot path beyond acceptable threshold.

### 11) Rollout steps

1. Ship tables + backend methods behind flags.
2. Enable sessionization without summarization for soak.
3. Enable summarization worker for small canary group(s).
4. Enable retrieval of summaries in prompt context.
5. Monitor quality/cost/error rates.

Rollback:

- set `CONTEXT_SESSION_MEMORY_ENABLED=false` and system reverts to old context behavior.

## Phase 2 (after Phase 1 stabilizes)

Status: **complete**.

Shipped (starter):

- Added `VECTOR_EMBEDDING_PROVIDER` with `deterministic|openai` options.
- Added `VECTOR_EMBEDDING_MODEL`, timeout, and max-input controls.
- Added OpenAI embedding call path with deterministic fallback.
- Added embedding pipeline metrics for session summary vector writes.

Shipped (completion):

1. **Contextualized embedding headers** (`src/utils/session-summary.ts` → `buildContextualizedEmbeddingInput`): Prepends group JID, time range, participants, and topic tags to summary text before embedding. Used at both write-time (session finalization) and query-time (session search) for symmetric enrichment.
2. **Session embedding backfill** (`src/utils/session-backfill.ts`): One-shot job that re-embeds existing summarized sessions with the current provider (e.g., when switching from deterministic to OpenAI). Batch processing with configurable rate limiting, progress callbacks, and missing-only mode.
3. **Lightweight reranker** (`src/utils/reranker.ts`): Post-retrieval merging of message-level and session summary candidates into a unified ranked list. Scoring model: weighted blend of base relevance score, recency decay (72h half-life), query token overlap, session type bonus (1.25×), and coverage deduplication (messages inside a retrieved session window get a 0.5× penalty).
4. **Reranker wired into context pipeline** (`src/middleware/context.ts`): When both message and session hits are available, they are merged through the reranker before formatting. Falls back to independent rendering when only one source has results.
5. **Offline eval harness** (`src/utils/eval-retrieval.ts`): Defines a QA test set (6 synthetic queries with expected/unexpected evidence tokens), generates matching synthetic data, runs the full retrieval+rerank pipeline, and reports recall@K, perfect recall count, and noise detection metrics.
6. **Demo defaults to OpenAI embeddings** (CDK `demoVectorEmbeddingProvider` now defaults to `'openai'` instead of inheriting from the main stack).

## Phase 3 (optional advanced)

1. Hybrid retrieval fusion (message/session/facts with configurable weights).
2. HyDE fallback for low-confidence retrieval cases.
3. Hierarchical memory summaries (session -> weekly rollup) if needed.
4. Vector backend abstraction expansion (Qdrant dual-read experiments).

## Cost envelope guidance

Primary cost driver is LLM session summarization.

Controls:

- summarize only closed sessions,
- skip small sessions,
- cap input length,
- batch worker throughput,
- low-cost summarizer model.

If cost pressure increases:

- lower summarization frequency,
- raise min session length,
- summarize every Nth session for low-activity groups.

## Risks and mitigations

- Over-compressed summaries lose detail.
  - Keep source window metadata and retain message-level retrieval.
- Summary hallucination.
  - Require extractive style prompt and short factual output format.
- Added complexity in ingest path.
  - Keep summarization async; keep ingest writes minimal.
- Drift in summary schema over time.
  - `summary_version` and migration hooks.

## Recommended first implementation scope

Phase 1 minimum slice:

1. session tables,
2. sessionization writes,
3. async summarization worker,
4. session retrieval in `formatContext`,
5. flags + tests + logging.

This is enough to materially improve memory quality with bounded operational risk and low incremental cost.
