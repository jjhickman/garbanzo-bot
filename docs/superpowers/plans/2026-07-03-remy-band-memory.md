# Remy Band Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give Remy a shared band knowledge base — a structured `songs` catalog with member commands, read tools, and prompt injection, plus reuse of the existing memory+Qdrant fact pipeline for members/gear/decisions/gigs — all gated behind `BAND_FEATURES_ENABLED`.

**Architecture:** One new structured `songs` table (backend + barrel + mappers + types, following the `memory`/`event_reminders` pattern). A `!song` command handler (member-accessible) for mutations; read-only AI tools + a compact prompt block so Remy knows the catalog. Members/gear/decisions/gigs reuse the existing fact memory unchanged. A `BAND_FEATURES_ENABLED` flag keeps the community bot inert.

**Tech Stack:** TypeScript (ESM), Node 20+, better-sqlite3 + pg, Zod, Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-03-remy-band-memory-design.md`. Every task serves it.
- **TypeScript strict**, no `any`, ESM (`.js` import extensions), Pino logger only, Zod for external input. `kebab-case.ts`, one concern per file, ~300-line ceiling.
- **Reuse, don't reinvent:** members/gear/decisions/gigs use the EXISTING `addMemory`/`searchMemory`/`search_community_memory` fact pipeline — do NOT build new fact infra. The only new table is `songs`.
- **Band gate:** `BAND_FEATURES_ENABLED` (default false) gates the `!song` command, the band tools, and the band-knowledge prompt block. With it false, the community/WhatsApp bot is byte-unaffected.
- **No regressions:** do not change WhatsApp behavior; don't break the prompt-eval set (`tests/evals/prompt-eval-set.json`) — re-run it after persona/tools changes.
- **New table = 8 sync points** (per the substrate report): `db-schema.ts` (sqlite DDL), `postgres-schema.sql` (pg DDL), `db-mappers.ts` (Row+map), `db-types.ts` (domain type), `db-sqlite.ts` (stmts+fns+backend obj+REQUIRED_CORE_TABLES), `db-postgres.ts` (methods+REQUIRED_CORE_TABLES), `db-backend.ts` (interface), `db.ts` (barrel + type re-export).
- **Verify env prefix:** `PATH="$HOME/.local/bin:$PATH" MESSAGING_PLATFORM=discord OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter DISCORD_OWNER_ID=111 DISCORD_BOT_TOKEN=test_tok BAND_FEATURES_ENABLED=true`. Postgres path isn't run locally (typecheck + CI cover it).
- **Commits:** `type(scope): desc`; author `Josh Hickman <25596491+jjhickman@users.noreply.github.com>`; run `npm run check` before source commits. Never merge — push, open PR, owner merges.
- **Branch:** `feat/remy-band-memory` (stacked on `feat/remy-discord-foundation`; spec already committed).

## File Structure

**Create:** `src/features/songs.ts` (command handler + song-domain helpers), `src/features/band-knowledge.ts` (prompt block). Tests: `tests/songs-db.test.ts`, `tests/songs-command.test.ts`, `tests/band-tools.test.ts`, `tests/band-knowledge.test.ts`.
**Modify:** `src/utils/config.ts` + `.env.example` (BAND_FEATURES_ENABLED), the 8 DB sync points (songs table), `src/ai/tools.ts` (+2 gated tools), `src/ai/persona.ts` (inject band block), the bang-command router (wire `!song`), `AGENTS.md` (decisions entry).

---

## Task 1: Config flag + `songs` table (DB layer)

**Files:** Modify `src/utils/config.ts`, `.env.example`, `src/utils/db-schema.ts`, `src/utils/postgres-schema.sql`, `src/utils/db-mappers.ts`, `src/utils/db-types.ts`, `src/utils/db-sqlite.ts`, `src/utils/db-postgres.ts`, `src/utils/db-backend.ts`, `src/utils/db.ts`. Test: `tests/songs-db.test.ts`.

**Interfaces:**
- Produces: `config.BAND_FEATURES_ENABLED: boolean`. Domain type `Song { id: number; title: string; key: string | null; tempo: number | null; status: SongStatus; notes: string | null; createdAt: number; updatedAt: number }`, `type SongStatus = 'idea' | 'rough' | 'tight' | 'gig-ready'`. Backend + barrel: `addSong(input: { title; key?; tempo?; status?; notes? }): Promise<Song>`, `getSongById(id): Promise<Song | undefined>`, `getSongByTitle(title): Promise<Song | undefined>` (case-insensitive), `listSongs(status?): Promise<Song[]>`, `updateSong(id, patch: Partial<{ title; key; tempo; status; notes }>): Promise<Song | undefined>` (bumps updatedAt), `deleteSong(id): Promise<boolean>`.

- [ ] **Step 1: Write failing test** `tests/songs-db.test.ts` (sqlite via the shared-layer harness pattern in `tests/db-shared-layer.test.ts`): add a song (defaults status `idea`), getById/getByTitle (case-insensitive), list (all + status filter), updateSong patches only provided fields and bumps updatedAt (assert updatedAt >= createdAt), deleteSong returns true then getById undefined.
- [ ] **Step 2: Run → FAIL** (with the discord+band env prefix).
- [ ] **Step 3: Implement** the config flag (booleanFromEnv default false) + `.env.example`; then the songs table across the 8 sync points, mirroring the `memory` table exactly (read `db-schema.ts`/`postgres-schema.sql`/`db-mappers.ts`/`db-sqlite.ts`/`db-postgres.ts`/`db-backend.ts`/`db.ts` memory blocks first). SQLite DDL: `CREATE TABLE IF NOT EXISTS songs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, song_key TEXT, tempo INTEGER, status TEXT NOT NULL DEFAULT 'idea', notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)` + index on `lower(title)` and `status`. Postgres: `BIGSERIAL`/`BIGINT`. Add `'songs'` to both `REQUIRED_CORE_TABLES`. (`key` is a SQL keyword — use column `song_key`, map to `key` in the domain type.)
- [ ] **Step 4: Run → PASS + full check** (`npm run check`).
- [ ] **Step 5: Commit** `feat(band): BAND_FEATURES_ENABLED + songs table`

---

## Task 2: `!song` command handler

**Files:** Create `src/features/songs.ts`. Test: `tests/songs-command.test.ts`.

**Interfaces:**
- Consumes: the Task 1 barrel functions.
- Produces: `handleSongCommand(args: string): Promise<string>` — subcommands `add <title> [key=..] [tempo=..] [status=..]`, `list [status]`, `show <title>`, `set <title> <field=value>...`, `delete <title>`; a usage string on unknown/empty. Also `formatSongLine(song): string` (`Sundown (E, 120bpm, gig-ready)`), reused by tools + prompt block.

- [ ] **Step 1: Write failing test** — add parses key/tempo/status tokens and rejects a bad status; list renders all + filters by status; set updates fields (and rejects bad status); show renders one; delete removes; unknown subcommand → usage. Mock the db barrel (`vi.mock('../src/utils/db.js', ...)`) mirroring `tests/semantic-memory-search.test.ts`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `songs.ts`: a small token parser for `field=value` pairs, status validated against the enum, friendly errors, calls the barrel. `formatSongLine` handles null key/tempo gracefully.
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(band): !song command handler`

---

## Task 3: Wire `!song` into command routing (band-member gated)

**Files:** Modify the bang-command dispatch (find where `!memory` is routed — likely `src/core/response-router.ts` or `src/platforms/*/owner-commands`/`process-group-message`). Test: extend the routing test or `tests/songs-command.test.ts`.

**Interfaces:**
- Consumes: `handleSongCommand`, `config.BAND_FEATURES_ENABLED`, and (Discord) the foundation's `isBandMember`/owner check.
- Produces: `!song …` routes to `handleSongCommand` when `BAND_FEATURES_ENABLED` and the sender is authorized (owner OR band role on Discord; owner-only elsewhere). Off → `!song` either falls through (unhandled) or replies band-features-disabled; unauthorized → a brief decline.

- [ ] **Step 1: Read** how `!memory` is dispatched (grep `handleMemory`) and how owner/permission is checked; mirror it. Write a failing test asserting `!song list` routes to the handler when enabled+authorized, and does not when the flag is off.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the routing + gate. Keep the permission model consistent with the platform (Discord band-role via discord-config; WhatsApp owner).
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(band): route !song with band-member gating`

---

## Task 4: Band read tools (`list_band_songs`, `find_band_song`)

**Files:** Modify `src/ai/tools.ts`. Test: `tests/band-tools.test.ts`.

**Interfaces:**
- Consumes: Task 1 barrel (`listSongs`, `getSongByTitle`/fuzzy), `formatSongLine`, `config.BAND_FEATURES_ENABLED`.
- Produces: two `AiTool`s — `list_band_songs` (optional `status` param → catalog lines), `find_band_song` (`title` param → best match or "no match"). Both appended to the `tools` array and gated in `getEnabledTools` behind `BAND_FEATURES_ENABLED`.

- [ ] **Step 1: Write failing test** — with the flag on, `getEnabledTools()` includes both tools; each `execute` returns formatted song data (mock the songs feature/db). With the flag off, neither tool is enabled.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** two tools (lazy-import the songs feature in `execute`, per the existing tool pattern) + the `getEnabledTools` gate.
- [ ] **Step 4: Run → PASS + full check** (re-run `tests/evals/prompt-eval-set.json`-backed tests / the eval schema test).
- [ ] **Step 5: Commit** `feat(band): list_band_songs + find_band_song tools`

---

## Task 5: Band-knowledge prompt block

**Files:** Create `src/features/band-knowledge.ts`. Modify `src/ai/persona.ts`. Test: `tests/band-knowledge.test.ts`.

**Interfaces:**
- Consumes: `listSongs`, `formatSongLine`, `config.BAND_FEATURES_ENABLED`.
- Produces: `formatBandKnowledgeForPrompt(): Promise<string>` → `"Band songs you know:\n- <line>\n…"` capped to N songs/chars; empty string when flag off or no songs. Injected into `buildSystemPrompt` (and the Ollama distilled prompt) next to the memories block.

- [ ] **Step 1: Write failing test** — renders the catalog block for a few songs; empty string when flag off; empty when no songs. Assert persona `buildSystemPrompt` includes the block when band on (mock listSongs + config).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `band-knowledge.ts` + inject into persona.ts (guard by flag; keep the existing memories injection intact).
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(band): inject song catalog into Remy's prompt`

---

## Task 6: Final review + PR

- [ ] **Step 1:** AGENTS.md decisions entry (band memory: songs table + fact reuse + BAND_FEATURES_ENABLED gate). Commit.
- [ ] **Step 2:** Push `feat/remy-band-memory`; open PR (base: the foundation branch, since stacked — or main with a note that #224 merges first). Body: what it delivers, that it's Remy sub-project 1 stacked on #224, `BAND_FEATURES_ENABLED` usage, test evidence, follow-ups (setlists→practice, sections/lyrics→songwriting, semantic song search deferred). Do NOT merge.

---

## Self-Review

**Spec coverage:** songs table (T1) ✓; `!song` mutations + routing/perm (T2, T3) ✓; read tools (T4) ✓; prompt injection (T5) ✓; band gate everywhere (T1 flag used in T3/T4/T5) ✓; facts reuse (no task — deliberately unchanged) ✓; no-regression (flag default false) ✓.
**Placeholder scan:** T3 says "find where !memory is routed" — a named-grep directive (`handleMemory`), not a vague TODO; the router location is discovered, not guessed.
**Type consistency:** `Song`/`SongStatus`, barrel fn names, `handleSongCommand`, `formatSongLine`, `formatBandKnowledgeForPrompt`, the two tool names, and `BAND_FEATURES_ENABLED` are used verbatim across tasks. `song_key` column ↔ `key` domain field noted in T1.
