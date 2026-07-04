# Remy Songwriting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Capture song ideas (text + dropped audio → Whisper), organize per-song sections/lyrics/chords (Headchart seed), and promote ideas along the idea→demo→ready pipeline — all gated behind `BAND_FEATURES_ENABLED`.

**Architecture:** Two new tables (`song_ideas`, `song_sections`) on the `songs` 8-sync-point pattern. New Discord audio-attachment plumbing (additive `InboundMessage.audio?`) so a dropped clip reaches a handler, then reuse the existing `transcribeAudio` (Whisper). Commands copy the `!song` routing + owner/band gate. Reuse `songs.status` as the pipeline. Discord-only for audio; degrades gracefully with no Whisper server.

**Tech Stack:** TypeScript (ESM), Node 20+, better-sqlite3 + pg, Zod, Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-03-remy-songwriting-design.md`. Every task serves it.
- **TS strict**, no `any`, ESM (`.js`), Pino logger, Zod for external input. `kebab-case.ts`, one concern/file, ~300-line ceiling.
- **Band gate:** everything behind `BAND_FEATURES_ENABLED` (default false → community/WhatsApp byte-unaffected). Mutations require owner || `senderIsBandMember` (copy the `!song`/`!rehearsal` gate in `process-group-message.ts`).
- **Reuse:** `transcribeAudio(buffer, mimeType)` (src/features/voice.ts) for transcription; `songs.status` (idea/rough/tight/gig-ready) as the pipeline; the 8-sync-point table pattern (templates: `songs`, `setlist_songs`, `availability`); `parseTitleAndFields`/`formatSongLine`/`getSongByTitle` from songs.ts; tool gating in `getEnabledTools`. sqlite runs WITHOUT `PRAGMA foreign_keys=ON` → FK cascades done IN CODE.
- **New table = 8 sync points:** db-schema.ts, postgres-schema.sql, db-mappers.ts, db-types.ts, db-sqlite.ts, db-postgres.ts (+ `REQUIRED_CORE_TABLES` — the ONLY such list, in db-postgres.ts), db-backend.ts, db.ts.
- **Audio degrades gracefully:** if fetch or `transcribeAudio` fails/returns null, still store the idea (audioUrl set, transcript null); never throw. No raw-audio persistence — transcript (DB text) + Discord CDN url only.
- **No real network in tests:** mock `fetch` + `transcribeAudio`. No regressions; prompt-eval set green after tools.ts change.
- **Verify env prefix:** `PATH="$HOME/.local/bin:$PATH" MESSAGING_PLATFORM=discord OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter DISCORD_OWNER_ID=111 DISCORD_BOT_TOKEN=test_tok BAND_FEATURES_ENABLED=true`. ALWAYS set it. Postgres via typecheck + CI.
- **Commits:** `type(scope): desc`; GitHub noreply author; `npm run check` before source commits. Never merge — push, PR, owner merges.
- **Branch:** `feat/remy-songwriting` (stacked on `feat/remy-practice`; rebase onto main after #226 merges). Spec already committed.

## File Structure

**Create:** `src/features/song-ideas.ts`, `src/features/song-sections.ts`. Tests: `tests/song-ideas-db.test.ts`, `tests/song-sections-db.test.ts`, `tests/discord-audio-attachment.test.ts`, `tests/song-ideas-command.test.ts`, `tests/song-sections-command.test.ts`, `tests/songwriting-tools.test.ts`.
**Modify:** the 8 DB sync points (×2 tables), `src/core/inbound-message.ts` (+`audio?`), `src/platforms/discord/gateway-client.ts` + `processor.ts` (surface audio attachment), `src/core/process-inbound-message.ts` + `process-group-message.ts` (thread `audio` to handlers), `src/features/router.ts` (+3 bang commands), `src/ai/tools.ts` (+2 gated tools), `AGENTS.md`.

---

## Task 1: `song_ideas` table (DB layer)

**Files:** the 8 DB sync points. Test: `tests/song-ideas-db.test.ts`.

**Interfaces:**
- Produces: `interface SongIdea { id: number; title: string | null; text: string | null; audioUrl: string | null; transcript: string | null; songId: number | null; createdBy: string | null; createdAt: number }`. Barrel: `addSongIdea({title?, text?, audioUrl?, transcript?, songId?, createdBy?})`, `getSongIdeaById(id)`, `listSongIdeas(limit?)` (newest first), `linkSongIdeaToSong(ideaId, songId)`, `deleteSongIdea(id)`.

- [ ] **Step 1: Write failing test** (sqlite shared-layer harness like `tests/song-ideas-db.test.ts`↔`songs-db.test.ts`): add (text-only, and with audioUrl+transcript) → get; listSongIdeas newest-first + limit; linkSongIdeaToSong sets song_id; deleteSongIdea.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** across the 8 sync points (mirror `songs`). SQLite: `CREATE TABLE IF NOT EXISTS song_ideas (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, text TEXT, audio_url TEXT, transcript TEXT, song_id INTEGER REFERENCES songs(id) ON DELETE SET NULL, created_by TEXT, created_at INTEGER NOT NULL)` + index on created_at. Postgres mirror (BIGSERIAL/BIGINT). Add `'song_ideas'` to `REQUIRED_CORE_TABLES`. (song_id nullable; on song delete it's set null — but sqlite FK inert, so also handle in Task 2's deleteSong change / or here note it; for now the column is nullable and `linkSongIdeaToSong` sets it.)
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(songwriting): song_ideas table`

---

## Task 2: `song_sections` table (DB layer) + deleteSong cleanup

**Files:** the 8 DB sync points; modify `deleteSong` (both backends). Test: `tests/song-sections-db.test.ts`.

**Interfaces:**
- Produces: `type SectionKind = 'intro'|'verse'|'chorus'|'bridge'|'solo'|'outro'|'other'`; `interface SongSection { id: number; songId: number; kind: SectionKind; position: number; lyrics: string | null; chords: string | null; createdAt: number; updatedAt: number }`. Barrel: `addSongSection({songId, kind, lyrics?, chords?, position?})` (append if no position), `getSongSections(songId)` (ordered by position), `updateSongSection(id, patch)`, `moveSongSection(id, newPosition)` (transactional reorder like `moveSetlistSong`), `removeSongSection(id)` (gap-close).

- [ ] **Step 1: Write failing test** — addSongSection appends contiguous positions; getSongSections ordered; updateSongSection patches lyrics/chords/kind + bumps updated_at; moveSongSection reorders (respects UNIQUE(song_id, position)); removeSongSection closes gaps; deleting a SONG (`deleteSong`) removes its song_sections AND nulls its song_ideas.song_id.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** SQLite: `CREATE TABLE IF NOT EXISTS song_sections (id INTEGER PRIMARY KEY AUTOINCREMENT, song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('intro','verse','chorus','bridge','solo','outro','other')), position INTEGER NOT NULL, lyrics TEXT, chords TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(song_id, position))` + index on (song_id, position). Postgres mirror. Add `'song_sections'` to `REQUIRED_CORE_TABLES`. Reorder uses the negative-then-final two-phase transaction pattern from `moveSetlistSong` (read it). **Extend `deleteSong` (both backends)** to also `DELETE FROM song_sections WHERE song_id=?` and `UPDATE song_ideas SET song_id=NULL WHERE song_id=?` (in code, since sqlite FK cascade/set-null is inert).
- [ ] **Step 4: Run → PASS + full check** (song_ideas-db + songs-db still green after the deleteSong change).
- [ ] **Step 5: Commit** `feat(songwriting): song_sections table + deleteSong cleanup`

---

## Task 3: Discord audio-attachment plumbing

**Files:** Modify `src/core/inbound-message.ts`, `src/platforms/discord/gateway-client.ts`, `src/platforms/discord/processor.ts`, `src/core/process-inbound-message.ts`, `src/core/process-group-message.ts`. Test: `tests/discord-audio-attachment.test.ts`.

**Interfaces:**
- Produces: `InboundMessage.audio?: { url: string; contentType: string }` (platform-agnostic, undefined when absent). The Discord gateway populates it from the first `audio/*` attachment; it's threaded through the dispatch to the group-message feature handlers as `audio`.

- [ ] **Step 1: Read** how `mapMessageToPayload` (gateway-client.ts) currently reduces attachments to `hasVisualMedia`, and how `hasMedia` threads from `process-inbound-message.ts` (the `handleGroupMessage` hook `{inbound, text, hasMedia}`) into `ProcessGroupMessageParams`. Write a failing test `tests/discord-audio-attachment.test.ts`: a discord.js message whose attachments include an `audio/mpeg` (or `.m4a`) item → `mapMessageToPayload` sets `inbound.audio = { url, contentType }`; a message with only an image attachment → `audio` undefined; the audio field reaches the group handler.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Add `audio?` to `InboundMessage`. In `gateway-client.ts` `mapMessageToPayload`, inspect the attachment collection; pick the first whose `contentType`/`content_type` starts with `audio/` (or filename ends `.m4a/.ogg/.mp3/.wav`), set `audio = { url, contentType }` (narrow from `unknown` with the file's helpers, no `any`). In `processor.ts` `normalizeDiscordInboundFromMessage`/schema, carry `audio` through. In `process-inbound-message.ts`, pass `audio` into the `handleGroupMessage` hook payload; in `process-group-message.ts`, add `audio?` to `ProcessGroupMessageParams` and pass it to the feature handlers that need it (the idea handler in Task 4). WhatsApp/others: `audio` stays undefined (no change to their behavior).
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(discord): surface audio attachments on inbound messages`

---

## Task 4: `!idea` command + audio capture + routing

**Files:** Create `src/features/song-ideas.ts`. Modify `src/features/router.ts`, `src/core/process-group-message.ts`. Test: `tests/song-ideas-command.test.ts`.

**Interfaces:**
- Consumes: Task 1 barrel; `addSong` (promote); `transcribeAudio` (voice.ts); `InboundMessage.audio` (Task 3, via ctx); global `fetch`.
- Produces: `handleIdeaCommand(args, ctx: { senderId: string; audio?: { url: string; contentType: string } }): Promise<string>` — `capture [title] [| text]` (if ctx.audio present → fetchAndTranscribe → store transcript+url; else store text idea), `list`, `show <id>`, `promote <id> [title]` (→ addSong({title, status:'idea'}) + linkSongIdeaToSong), `delete <id>`, unknown→usage. `formatIdeaLine(idea)`. `fetchAndTranscribe(url, contentType): Promise<string|null>` — `fetch(url)` → arrayBuffer → Buffer → `transcribeAudio(buffer, contentType)`; returns null on ANY failure (guarded, logged).

- [ ] **Step 1: Write failing test** (mock db barrel, mock `fetch` global, mock `transcribeAudio`): capture text-only; capture with audio → fetch+transcribe stores transcript+audioUrl; capture with audio where transcribeAudio returns null → still stores idea (audioUrl set, transcript null) + notes transcription unavailable; list/show/not-found; promote creates a song (addSong status idea) + links; delete; unknown→usage. Run RED → GREEN.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the handler + `fetchAndTranscribe` (guarded) + routing (`idea` bang + `handleIdeaFeature` gated on BAND_FEATURES_ENABLED + owner/band, passing ctx.audio from ProcessGroupMessageParams).
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(songwriting): !idea capture (text + audio→Whisper) + promote`

---

## Task 5: `!section` + `!lyrics` commands + routing

**Files:** Create `src/features/song-sections.ts`. Modify `src/features/router.ts`, `src/core/process-group-message.ts`. Test: `tests/song-sections-command.test.ts`.

**Interfaces:**
- Consumes: Task 2 barrel; `getSongByTitle`; `parseTitleAndFields`.
- Produces: `handleSectionCommand(args)` — `add <song> <kind> [lyrics=..] [chords=..]`, `list <song>`, `edit <song> <position> [lyrics=..] [chords=..] [kind=..]`, `move <song> <position> <newPosition>`, `remove <song> <position>`. `handleLyricsCommand(args)` — `show <song>` (renders `formatSongSheet`), `set <song> <kind> <lyrics...>` (add-or-append a section with lyrics). `formatSection(section)` + `formatSongSheet(song, sections)` (numbered: `1. [chorus] <lyrics> / <chords>`). Resolve song via `getSongByTitle` (first token(s) = song name via the setlist longest-prefix approach, or a documented convention); validate `kind` against SectionKind; friendly not-found/bad-kind/bad-position.

- [ ] **Step 1: Write failing test** — add parses kind/lyrics/chords + rejects bad kind; list renders sections; edit updates fields; move reorders; remove; lyrics show renders the sheet; lyrics set adds a section; unknown song → not-found; unknown subcommand → usage. Mock db + songs.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** both handlers + routing (`section`/`lyrics` bangs + gated handlers copying `!song`).
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(songwriting): !section + !lyrics commands`

---

## Task 6: AI tools (`get_song_sections`, `list_song_ideas`)

**Files:** Modify `src/ai/tools.ts`. Test: `tests/songwriting-tools.test.ts`.

**Interfaces:**
- Consumes: `getSongByTitle`/`getSongSections`/`formatSongSheet`, `listSongIdeas`/`formatIdeaLine`, `config.BAND_FEATURES_ENABLED`.
- Produces: `get_song_sections` (param `title` → the song's section sheet or not-found) and `list_song_ideas` (recent ideas), gated behind `BAND_FEATURES_ENABLED` in `getEnabledTools`.

- [ ] **Step 1: Write failing test** — with the flag on both tools appear in `getEnabledTools()` + execute returns formatted data; with the flag off neither appears. Mock db/features.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the two tools (lazy-import) + gating + prompt-eval `VALID_TOOLS` allow-list.
- [ ] **Step 4: Run → PASS + full check** (prompt-eval test).
- [ ] **Step 5: Commit** `feat(songwriting): get_song_sections + list_song_ideas tools`

---

## Task 7: Final review + PR

- [ ] **Step 1:** AGENTS.md decisions entry (songwriting: song_ideas/song_sections tables; audio capture is explicit `!idea` on a dropped clip, transcript+CDN-URL stored not bytes, graceful without a Whisper server; Discord audio-attachment plumbing added; idea→demo→ready = songs.status; all `BAND_FEATURES_ENABLED`-gated). Commit.
- [ ] **Step 2:** If PR #226 merged, rebase onto main (`git rebase --onto origin/main <practice-tip>`). Push `feat/remy-songwriting`; open PR against main. Body: what it delivers, the explicit-audio + graceful-degradation decisions, the WHISPER_URL requirement, `BAND_FEATURES_ENABLED` usage, test evidence, follow-ups (live recording deferred, CDN-URL expiry, Headchart rendering). Do NOT merge.

---

## Self-Review

**Spec coverage:** idea capture text+audio (T3, T4) ✓; sections/lyrics/chords Headchart seed (T2, T5) ✓; idea→demo→ready via songs.status + promote (T4) ✓; recall tools (T6) ✓; band gate everywhere (BAND_FEATURES_ENABLED in T4/T5/T6) ✓; graceful audio degradation (T4 fetchAndTranscribe null path) ✓; no-regression (flag default false; audio additive/undefined off-Discord) ✓.
**Placeholder scan:** T3 specifies the exact attachment-filter (`audio/*` contentType or `.m4a/.ogg/.mp3/.wav`), not a vague TODO; T2 flags the sqlite-inert-FK cascade with the in-code deleteSong fix.
**Type consistency:** `SongIdea`, `SongSection`/`SectionKind`, barrel fn names, `handleIdeaCommand`/`handleSectionCommand`/`handleLyricsCommand`, `fetchAndTranscribe`, `formatIdeaLine`/`formatSection`/`formatSongSheet`, `InboundMessage.audio`, the 2 tool names, and `BAND_FEATURES_ENABLED` used verbatim across tasks. Reuses `transcribeAudio`/`getSongByTitle`/`parseTitleAndFields`/`addSong`. New tables in `REQUIRED_CORE_TABLES`.
