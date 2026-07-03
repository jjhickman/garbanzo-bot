# Remy Sub-project 1 — Shared Band Memory — Design Spec

**Date:** 2026-07-03
**Status:** Draft (autonomous build; owner reviews at PR)
**Branch:** `feat/remy-band-memory` (stacked on `feat/remy-discord-foundation` / PR #224)
**Part of:** Remy band-bot (foundation → **band memory** → practice → songwriting).

## Summary

Give Remy a shared band knowledge base: a **structured song catalog** plus **freeform band facts** (members' gear, decisions, gig history), so the band can capture and recall "what key is Sundown in?", "which songs are gig-ready?", "what amp does Josh use?", "what did we decide about the outro?". The song catalog is the connective entity that practice (per-song status, setlists) and songwriting (sections, lyrics) build on next.

The design **maximally reuses** the existing memory + Qdrant substrate (already merged) and adds exactly **one new structured table (`songs`)** where free-text facts genuinely don't suffice.

## Goals

1. **Song catalog:** a structured `songs` table (title, key, tempo, status, notes) with member-accessible commands and read tools, so songs can be referenced by a stable id and have field-level state (the thing practice/songwriting need).
2. **Remy knows the catalog:** a compact song summary injected into Remy's system prompt so it can answer catalog questions in-context and ground its help.
3. **Band facts reuse:** members/gear, decisions, and gig history use the **existing** `!memory` + `search_community_memory` + Qdrant fact pipeline unchanged (band-flavored categories), so no new fact infrastructure.
4. **Capture + recall:** band members (not just owner) can add/update songs and facts; Remy recalls them via tools and prompt context.
5. **No regressions** to WhatsApp/community behavior; band features stay flag-gated and inert unless the deployment is a band deployment.

## Non-goals (deferred)

- **Setlists** and **per-song practice-status history / rehearsal tracking** → sub-project 2 (practice). The `songs.status` field seeds it; the setlist table lands there.
- **Song sections, lyrics, chord charts, audio clips** → sub-project 3 (songwriting), which extends the `songs` table/adds child tables.
- **Semantic "that song about the ocean" search** (a new Qdrant `kind:'song'`) → deferred; structured `find_band_song` (by title, fuzzy) covers sub-project 1's needs. Revisit in songwriting where lyrics/themes live.
- **Structured member/gear records** → members/gear are freeform facts here; promote to a table only if a real need appears.

## Decisions

- **Reuse facts for members/gear/decisions/gigs.** The existing `memory` table + `addMemory`/`searchMemory` + `indexFact`/`searchFacts` + `search_community_memory` tool already store, index, prompt-inject, and retrieve free-text facts. Band facts use band categories (`gear`, `decisions`, `gigs`, `members`); the category set is loosely enforced (manual `add` accepts any category), so no enum change is required — but the `!memory` help text and the auto-extract enum stay community-oriented (auto-extract is off by default; not changing it here).
- **One new table: `songs`.** Free-text facts can't be updated field-wise (`set status=tight`) or referenced by id (setlists), which practice needs — so songs are structured. Follows the established 6-file table pattern (schema ×2, mapper, type, backends ×2, DbBackend, barrel, both `REQUIRED_CORE_TABLES`).
- **Song mutations via commands, reads via tools.** AI tools' `execute` is read-only by convention (they return strings to the model); mutations happen through `!song` bang commands (available to band members via the foundation's role model). The AI gets read tools (`list_band_songs`, `find_band_song`) + the prompt summary.
- **Band-feature gate:** a `BAND_FEATURES_ENABLED` config flag (default false) gates the `!song` command, the band tools, and the band-knowledge prompt block, so the community bot is unaffected. A Remy deployment sets it true.

## Architecture

```
!song add/list/set/delete (band members)   →  src/features/songs.ts (command handler)
                                               │
                                               ▼
songs table (sqlite + postgres)  ← db-backend.ts + db.ts barrel + mappers + types
                                               │
list_band_songs / find_band_song (AI tools) ──┘  → src/ai/tools.ts (read-only, gated)
                                               │
formatBandKnowledgeForPrompt()  →  injected into src/ai/persona.ts system prompt
                                               │
members/gear/decisions/gigs  →  EXISTING memory + Qdrant fact pipeline (unchanged)
```

### Units

- **`songs` DB layer** — new table + `Song` domain type (`{ id, title, key, tempo, status, notes, createdAt, updatedAt }`; `status ∈ 'idea'|'rough'|'tight'|'gig-ready'`), `SongRow` + `mapSong`, SQLite + Postgres backends (`addSong`, `getSongById`, `getSongByTitle`, `listSongs`, `updateSong`, `deleteSong`), `DbBackend` methods, `db.ts` re-exports, both `REQUIRED_CORE_TABLES` updated. Title is unique-ish (case-insensitive lookup); `updateSong` patches provided fields + bumps `updatedAt`.
- **`src/features/songs.ts`** — `handleSongCommand(args): Promise<string>` implementing `!song` subcommands: `add <title> [key=..] [tempo=..] [status=..]`, `list [status]`, `set <title> <field=value>...`, `show <title>`, `delete <title>`. Parses `key=`/`tempo=`/`status=` tokens; validates status against the enum; friendly errors. Pure over the DB layer.
- **`src/features/band-knowledge.ts`** — `formatBandKnowledgeForPrompt(): Promise<string>` → a compact catalog block ("Band songs you know:\n- Sundown (E, 120bpm, gig-ready)\n- ...") capped to a sane length; empty string when no songs or band features off.
- **`src/ai/tools.ts`** — two read tools gated behind `BAND_FEATURES_ENABLED`: `list_band_songs` (optionally filtered by status) and `find_band_song` (fuzzy title). `execute` lazy-imports the songs feature and formats results. Gated in `getEnabledTools`.
- **`src/ai/persona.ts`** — inject `formatBandKnowledgeForPrompt()` output alongside the existing memories block (both the main and Ollama prompt, gated by band flag) so Remy knows the catalog on every path.
- **Command routing** — wire `!song` into the response router / bang-command dispatch the same way `!memory` is wired, with a band-member permission check (owner or band role) on Discord.

## Config

- `BAND_FEATURES_ENABLED` (bool, default false) — gates `!song`, band tools, band-knowledge prompt block. Documented in `.env.example`.

## Error handling / degradation

- Unknown `!song` subcommand / bad `status` value → friendly usage string, no throw.
- `find_band_song` no match → "no song matching …" (the model can then ask or search facts).
- Band features off → `!song` replies that band features are disabled; tools absent from `getEnabledTools`; prompt block empty. Community bot fully unaffected.
- DB failures logged (Pino), never crash the reply path.

## Testing

- **songs DB layer**: add/get/getByTitle(case-insensitive)/list(+status filter)/update(patch fields + updatedAt bump)/delete; both backends' shared-layer test (sqlite runs locally; postgres via typecheck + CI job).
- **`songs` feature**: each `!song` subcommand — add with key/tempo/status parsing, list + status filter, set field updates + bad-status rejection, show, delete, usage on unknown subcommand.
- **tools**: `list_band_songs`/`find_band_song` return formatted catalog data; both gated off when `BAND_FEATURES_ENABLED=false`.
- **prompt injection**: `formatBandKnowledgeForPrompt` renders the catalog; empty when no songs / flag off; persona includes it when band on. Re-run the prompt-eval set (`tests/evals/prompt-eval-set.json`) since persona/tools changed (per the Decisions Log).
- **Regression**: full suite green; community/WhatsApp path unaffected with `BAND_FEATURES_ENABLED` default false; `MESSAGING_PLATFORM=whatsapp` untouched.

## Rollout / what the owner provides

Set `BAND_FEATURES_ENABLED=true` on the Remy (Discord) deployment. Band members use `!song add …` to seed the catalog; members/gear/decisions/gigs via `!memory add …`. Rollback: `BAND_FEATURES_ENABLED=false`.

## Open questions (proceeding on stated defaults; owner can redirect at PR)

1. Members/gear as facts vs a structured table — proceeding with **facts** (reuse), promote later if needed.
2. Semantic song search (`kind:'song'`) — **deferred** to songwriting; structured find covers now.
3. Who can mutate songs — **owner + band role** (Discord); on non-Discord, owner only.
