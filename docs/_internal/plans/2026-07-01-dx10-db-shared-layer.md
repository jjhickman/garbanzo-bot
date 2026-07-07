# Plan — DX-10: SQLite/Postgres shared layer (Phase 6)

Spec: `docs/superpowers/specs/2026-06-27-whatsapp-login-openai-oauth-hardening-design.md` §Phase 6.
Branch: `codex/plan-garbanzobot-hardening`. Base: after DX-9.

## Goal

Reduce duplication between `src/utils/db-sqlite.ts` (~29 KB) and `src/utils/db-postgres.ts` (~42 KB)
by extracting shared **query-shaping and row-mapping** logic into a common layer behind the existing
`DbBackend` interface (`src/utils/db-backend.ts`). **Behavior- and schema-preserving.** Dialect-specific
bits (placeholder style `?` vs `$1`, connection/driver handling, dialect SQL quirks, FTS/`tsvector`
search) stay isolated in each backend.

## Guardrails (must stay green the entire time)

- `tests/postgres-backend.test.ts` (primary), plus any test that exercises DB reads/writes.
- `npm run typecheck`, `npm run lint`, full `npm test`, `npm run audit:deps`.
- Verify env prefix:
  `OWNER_JID='test_owner@s.whatsapp.net' OPENROUTER_API_KEY='test_key_ci' AI_PROVIDER_ORDER='openrouter'`

## Approach

The two backends already share `db-backend.ts` (interface), `db-types.ts` (row types), and
`db-schema.ts`. The duplication to remove is the pure, dialect-independent logic that currently
exists in both files:

1. **Row → typed-object mappers** — functions that take a raw DB row and produce a `MemberProfile`,
   `DbMessage`, `FeedbackEntry`, `MemoryEntry`, `WhatsAppOutboundJob`, `WhatsAppSafetyState`, etc.
   These are identical modulo column access. Extract to `db-mappers.ts`, parameterized over a plain
   row record so both dialects call the same mapper.
2. **Query-shaping helpers** — pure transforms with no SQL dialect (JSON (de)serialization of
   interests/reasons/options, strike aggregation shaping, `formatMemoriesForPrompt` text assembly,
   safety-metric derivation from counts, tokenizing search terms). Extract to `db-query-shape.ts`.
3. **Keep dialect-specific**: actual SQL strings, parameter binding, driver calls, FTS/`tsvector`
   full-text search, transactions, and migrations — these stay in `db-sqlite.ts` / `db-postgres.ts`.

Do **not** try to unify the SQL statements themselves — that risks schema/behavior drift and is
explicitly out of scope. Only extract logic that is provably identical in both files today.

## Tasks

- **T1 — Audit duplication.** Diff the two backends; produce a concrete list of provably-identical
  pure functions/blocks (mappers + shaping). No code change. Output the extraction list.
- **T2 — `db-mappers.ts`.** Move row→object mappers; both backends import them. Run guards after each.
- **T3 — `db-query-shape.ts`.** Move pure query-shaping/serialization helpers; wire both backends.
- **T4 — New unit tests.** `tests/db-shared-layer.test.ts` covering the extracted mappers/shapers
  directly (round-trip serialization, mapper field fidelity, edge cases: null options, empty
  interests, malformed JSON tolerance matching current behavior).
- **T5 — Full `npm run check`.** Confirm `postgres-backend.test.ts` and all DB paths still pass with
  identical behavior.

Each extraction is a behavior-preserving move. If sqlite and postgres differ in a block that looked
shared, **do not** force-unify — leave it dialect-specific and note the difference.

## Definition of done

- `db-mappers.ts` + `db-query-shape.ts` created; both backends consume them; net line reduction in
  `db-sqlite.ts` and `db-postgres.ts`.
- No schema change, no SQL semantic change.
- `tests/db-shared-layer.test.ts` added; full suite green, typecheck + lint clean, `audit:deps` 0.
- Independent Codex review confirms behavior/schema preservation.
