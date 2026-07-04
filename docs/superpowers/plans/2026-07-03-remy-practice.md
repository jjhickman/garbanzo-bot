# Remy Practice / Rehearsal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Help the band rehearse — schedule rehearsals with reminders, collect availability (stored, not polls), build ordered setlists from the song catalog, and auto-generate a practice agenda — all gated behind `BAND_FEATURES_ENABLED`.

**Architecture:** Three new structured areas (rehearsals, availability, setlists+setlist_songs) following the sub-project-1 `songs` table pattern; command handlers that copy the `!song` routing + owner/band gate; a Discord rehearsal-reminder scheduler mirroring `scheduleDiscordEventReminders`; a pure LLM-free agenda builder mirroring `buildWeeklyRecap`; two gated AI read tools. Remy is Discord-only (band gate is Discord-populated), so binders are Discord-only over platform-agnostic builders.

**Tech Stack:** TypeScript (ESM), Node 20+, better-sqlite3 + pg, Zod, Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-03-remy-practice-design.md`. Every task serves it.
- **TypeScript strict**, no `any`, ESM (`.js` imports), Pino logger only, Zod for external input. `kebab-case.ts`, one concern per file, ~300-line ceiling.
- **Band gate:** everything behind `BAND_FEATURES_ENABLED` (default false → community/WhatsApp bot byte-unaffected). Mutations require owner OR `senderIsBandMember` (copy the `!song` gate in `process-group-message.ts` `handleSongFeature`).
- **Reuse, don't reinvent:** per-song status = existing `songs.status`; scheduler = the option-B pure-builder + Discord-binder split (`src/platforms/discord/schedulers.ts` + `runtime.ts` disposers); command routing = `feature` union + `BANG_COMMANDS` in `src/features/router.ts` + a `handleXFeature` in `process-group-message.ts`; DB tables = the 8-sync-point `songs` pattern; AI tools = `list_band_songs` gating in `getEnabledTools`. Reuse `parseTitleAndFields` from `src/features/songs.ts` for `field=value` parsing.
- **New table = 8 sync points:** `db-schema.ts` (sqlite DDL), `postgres-schema.sql` (pg DDL), `db-mappers.ts` (Row+map), `db-types.ts` (domain type), `db-sqlite.ts` (stmts+fns+backend obj), `db-postgres.ts` (methods + `REQUIRED_CORE_TABLES`), `db-backend.ts` (interface), `db.ts` (barrel + type re-export). Watch postgres reserved words (songs aliased `key`→`song_key`).
- **No regressions:** don't change WhatsApp behavior; don't break the prompt-eval set (`tests/evals/prompt-eval-set.json`) — re-run after tools.ts changes.
- **Verify env prefix:** `PATH="$HOME/.local/bin:$PATH" MESSAGING_PLATFORM=discord OWNER_JID=test_owner@s.whatsapp.net OPENROUTER_API_KEY=test_key_ci AI_PROVIDER_ORDER=openrouter DISCORD_OWNER_ID=111 DISCORD_BOT_TOKEN=test_tok BAND_FEATURES_ENABLED=true`. ALWAYS set it or config validation fails many tests spuriously. Postgres path via typecheck + CI.
- **Commits:** `type(scope): desc`; author GitHub noreply; `npm run check` before source commits. Never merge — push, PR, owner merges.
- **Branch:** `feat/remy-practice` (stacked on `feat/remy-band-memory`; rebase onto main after #225 merges). Spec already committed.

## File Structure

**Create:** `src/features/rehearsals.ts` (rehearsal + availability commands), `src/features/setlists.ts`, `src/features/practice-agenda.ts`. Tests: `tests/rehearsals-db.test.ts`, `tests/rehearsals-command.test.ts`, `tests/availability.test.ts`, `tests/setlists-db.test.ts`, `tests/setlists-command.test.ts`, `tests/practice-agenda.test.ts`, `tests/discord-rehearsal-scheduler.test.ts`, `tests/practice-tools.test.ts`.
**Modify:** the 8 DB sync points (×3 table groups), `src/features/router.ts` (+4 bang commands), `src/core/process-group-message.ts` (+4 handlers), `src/platforms/discord/schedulers.ts` (+reminder binder), `src/platforms/discord/runtime.ts` (bind), `src/ai/tools.ts` (+2 gated tools), `src/utils/config.ts` (+ reminder-lead / practice-channel keys), `.env.example`, `AGENTS.md`.

---

## Task 1: `rehearsals` table (DB layer) + config

**Files:** the 8 DB sync points; `src/utils/config.ts` + `.env.example`. Test: `tests/rehearsals-db.test.ts`.

**Interfaces:**
- Produces: `type RehearsalStatus = 'scheduled' | 'done' | 'cancelled'`; `interface Rehearsal { id: number; scheduledAt: number; location: string | null; agenda: string | null; status: RehearsalStatus; reminderSent: boolean; createdBy: string | null; createdAt: number; updatedAt: number }`. Barrel: `addRehearsal({scheduledAt, location?, agenda?, createdBy?})`, `getRehearsalById(id)`, `listUpcomingRehearsals(nowSeconds, limit?)` (status='scheduled' & scheduledAt>=now, ascending), `getNextRehearsal(nowSeconds)`, `updateRehearsal(id, patch)`, `cancelRehearsal(id)` (status='cancelled'), `listRehearsalsNeedingReminder(nowSeconds)` (scheduled, reminder_sent=0, scheduledAt - lead <= now < scheduledAt), `markRehearsalReminderSent(id)`. Config: `REHEARSAL_REMINDER_LEAD_MINUTES` (int, default 120), `DISCORD_PRACTICE_CHANNEL_ID` (string, optional).

- [ ] **Step 1: Write failing test** `tests/rehearsals-db.test.ts` (sqlite shared-layer harness like `tests/songs-db.test.ts`): add → get; listUpcoming filters past/cancelled + orders ascending; getNextRehearsal; updateRehearsal patches + bumps updated_at; cancelRehearsal; listRehearsalsNeedingReminder respects the lead window + reminder_sent flag; markRehearsalReminderSent flips it.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the config keys + the `rehearsals` table across the 8 sync points (mirror `songs`). SQLite: `CREATE TABLE IF NOT EXISTS rehearsals (id INTEGER PRIMARY KEY AUTOINCREMENT, scheduled_at INTEGER NOT NULL, location TEXT, agenda TEXT, status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','done','cancelled')), reminder_sent INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)` + index on `(status, scheduled_at)`. Postgres mirror (BIGSERIAL/BIGINT, BOOLEAN reminder_sent). Add `'rehearsals'` to `REQUIRED_CORE_TABLES`.
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(practice): rehearsals table + reminder config`

---

## Task 2: `!rehearsal` command + routing

**Files:** Create `src/features/rehearsals.ts`. Modify `src/features/router.ts`, `src/core/process-group-message.ts`. Test: `tests/rehearsals-command.test.ts`.

**Interfaces:**
- Consumes: Task 1 barrel; `parseTitleAndFields` (songs.ts); a date parser (see below).
- Produces: `handleRehearsalCommand(args: string, ctx: { senderId: string }): Promise<string>` — subcommands `schedule when=<date> [location=..] [agenda=..]`, `list`, `show <id>`, `cancel <id>`, `note <id> <text>` (sets agenda). `formatRehearsalLine(r): string` (`#3 · Thu Jul 9, 7:00pm · Studio A · scheduled`). A small date parser `parseRehearsalWhen(value): number | null` accepting `YYYY-MM-DD HH:MM` and a few relative forms; return null (friendly error) on unparseable. Route `rehearsal` in the `feature` union + `BANG_COMMANDS`; `handleRehearsalFeature` in process-group-message copies the `!song` `BAND_FEATURES_ENABLED` + owner/band gate (mutations gated; `list`/`show` may be open in-band).

- [ ] **Step 1: Write failing test** — schedule parses when/location/agenda + rejects bad date; list renders upcoming; show/cancel/note; unknown subcommand → usage. Mock the db barrel.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the handler + date parser + routing/gate.
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(practice): !rehearsal command + routing`

---

## Task 3: `availability` table + `!available` command + read-back

**Files:** the 8 DB sync points (availability table); Modify `src/features/rehearsals.ts` (availability handler + fold read-back into `show`), `src/features/router.ts`, `src/core/process-group-message.ts`. Test: `tests/availability.test.ts`.

**Interfaces:**
- Produces: `interface Availability { id; rehearsalId; memberId; memberName: string|null; response: 'yes'|'no'|'maybe'; respondedAt }`. Barrel: `setAvailability(rehearsalId, memberId, memberName, response)` (UPSERT on UNIQUE(rehearsal_id, member_id)), `listAvailability(rehearsalId)`. `handleAvailabilityCommand(args, ctx: { senderId, senderName? }): Promise<string>` — `!available <rehearsalId> yes|no|maybe`; validates the rehearsal exists + is scheduled + future; friendly errors. `!rehearsal show <id>` now appends a "Coming: … / Out: … / Maybe: …" summary from `listAvailability`.

- [ ] **Step 1: Write failing test** — setAvailability upserts (second vote by same member updates, doesn't duplicate); listAvailability groups; `!available` rejects unknown/cancelled/past rehearsal; `show` renders the availability summary. Mock db.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the availability table (UNIQUE(rehearsal_id, member_id), FK rehearsal_id) + the command + read-back + routing (`available` bang, gated — any band member may set their own availability).
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(practice): availability tracking (!available) + rehearsal read-back`

---

## Task 4: `setlists` + `setlist_songs` tables (DB layer)

**Files:** the 8 DB sync points (two tables). Test: `tests/setlists-db.test.ts`.

**Interfaces:**
- Produces: `interface Setlist { id; name; notes: string|null; createdAt; updatedAt }`; `interface SetlistSong { id; setlistId; songId; position }`; a joined `interface SetlistEntry { position; song: Song }`. Barrel: `addSetlist({name, notes?})`, `getSetlistByName(name)` (case-insensitive), `listSetlists()`, `deleteSetlist(id)`, `addSongToSetlist(setlistId, songId, position?)` (append if no position), `removeSongFromSetlist(setlistId, songId)` (and re-close position gaps), `moveSetlistSong(setlistId, songId, newPosition)`, `getSetlistSongs(setlistId): SetlistEntry[]` (JOIN songs, ORDER BY position). `deleteSong` (sub-project 1) must also delete the song's `setlist_songs` rows — add that cleanup to the existing `deleteSong` (or an FK ON DELETE CASCADE in the new table).

- [ ] **Step 1: Write failing test** — addSetlist + getByName (case-insensitive); addSongToSetlist appends positions; getSetlistSongs returns joined Song data in order; moveSetlistSong reorders; removeSongFromSetlist closes gaps; deleting a song removes its setlist entries; deleteSetlist cascades its songs.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** both tables across the 8 sync points. `setlist_songs(setlist_id INTEGER NOT NULL REFERENCES setlists(id) ON DELETE CASCADE, song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE, position INTEGER NOT NULL, UNIQUE(setlist_id, position))` (sqlite needs `PRAGMA foreign_keys=ON` — verify it's set in db-sqlite; if not, do the cleanup in code). Add both table names to `REQUIRED_CORE_TABLES`.
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(practice): setlists + setlist_songs tables`

---

## Task 5: `!setlist` command + routing

**Files:** Create `src/features/setlists.ts`. Modify `src/features/router.ts`, `src/core/process-group-message.ts`. Test: `tests/setlists-command.test.ts`.

**Interfaces:**
- Consumes: Task 4 barrel; `getSongByTitle` (songs); `formatSongLine` (songs).
- Produces: `handleSetlistCommand(args): Promise<string>` — `create <name> [notes=..]`, `list`, `show <name>`, `add <name> <songTitle> [position=..]`, `remove <name> <songTitle>`, `move <name> <songTitle> <position>`, `delete <name>`. `formatSetlist(setlist, entries): string` (numbered list of `formatSongLine`). Resolves song titles via `getSongByTitle`; friendly not-found for missing song/setlist. Route `setlist` bang + `handleSetlistFeature` gate (copy `!song`).

- [ ] **Step 1: Write failing test** — create/list/show; add resolves a song title + appends; add unknown song → not-found; remove; move reorders; delete; unknown subcommand → usage. Mock db + songs.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the handler + routing/gate.
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(practice): !setlist command + routing`

---

## Task 6: Practice agenda (pure builder) + `!agenda`

**Files:** Create `src/features/practice-agenda.ts`. Modify `src/features/router.ts`, `src/core/process-group-message.ts`. Test: `tests/practice-agenda.test.ts`.

**Interfaces:**
- Consumes: `listSongs` (status filters), `getNextRehearsal`, `getSetlistSongs`/`listSetlists`, `formatSongLine`, `formatRehearsalLine`, `config.BAND_FEATURES_ENABLED`.
- Produces: `buildPracticeAgenda(now = new Date()): Promise<string>` — pure, NO LLM (mirror `buildWeeklyRecap`): "Next rehearsal: <line or none>", "Needs work:" (listSongs('rough') + listSongs('idea')), optionally "Set to run:" (the most recent/only setlist). Returns a friendly "nothing scheduled yet" when empty. `handleAgendaCommand(): Promise<string>`. Route `agenda` bang (read-only; allowed in-band).

- [ ] **Step 1: Write failing test** — renders next rehearsal + needs-work songs + setlist; friendly message when no data; is LLM-free (no getResponse/model call). Mock db.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the builder + command + routing.
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(practice): practice agenda builder + !agenda`

---

## Task 7: Discord rehearsal-reminder scheduler + runtime binding

**Files:** Modify `src/platforms/discord/schedulers.ts`, `src/platforms/discord/runtime.ts`. Test: `tests/discord-rehearsal-scheduler.test.ts`.

**Interfaces:**
- Consumes: `listRehearsalsNeedingReminder`, `markRehearsalReminderSent`, `getRehearsalById`, `formatRehearsalLine`, `config` (lead + practice channel), the `PlatformMessenger`.
- Produces: `scheduleDiscordRehearsalReminders(messenger, targetChannelId): () => void` — mirror `scheduleDiscordEventReminders`: a ~5-min poller that reads `listRehearsalsNeedingReminder(now)`, sends a reminder via `messenger.sendText(targetChannelId, …)`, marks sent, with per-item try/catch and a disposer. Gated by `EVENT_REMINDERS_ENABLED` (no-op disposer when off). Optionally `scheduleDiscordPracticeAgenda(messenger, targetChannelId): () => void` (weekly `buildPracticeAgenda` post, no-op unless `DISCORD_PRACTICE_CHANNEL_ID` set). Bind both in `runtime.ts` disposers (target = `config.DISCORD_PRACTICE_CHANNEL_ID ?? ownerDmChannelId`).

- [ ] **Step 1: Write failing test** (fake timers, mirror `tests/discord-schedulers.test.ts`): advancing time triggers a reminder send + markRehearsalReminderSent for a due rehearsal; no double-send; disposer stops it; no-op when the gate flag is off.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the binder(s) + runtime wiring (injectable dep like the other schedulers; disposers cleaned in `stop()`). Do NOT import Baileys / touch whatsapp/**.
- [ ] **Step 4: Run → PASS + full check.**
- [ ] **Step 5: Commit** `feat(practice): Discord rehearsal-reminder scheduler`

---

## Task 8: AI tools (`next_rehearsal`, `current_setlist`)

**Files:** Modify `src/ai/tools.ts`. Test: `tests/practice-tools.test.ts`.

**Interfaces:**
- Consumes: `getNextRehearsal`/`formatRehearsalLine`, `listSetlists`/`getSetlistSongs`/`formatSetlist`, `config.BAND_FEATURES_ENABLED`.
- Produces: `next_rehearsal` (no params → the next scheduled rehearsal + its availability summary) and `current_setlist` (optional `name` → that setlist, else the only/most-recent) as `AiTool`s, lazy-importing their features, gated behind `BAND_FEATURES_ENABLED` in `getEnabledTools`.

- [ ] **Step 1: Write failing test** — with the flag on, both tools appear in `getEnabledTools()` and their execute returns formatted data; with the flag off, neither appears. Mock db/features.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the two tools + gating (also add their names to the prompt-eval `VALID_TOOLS` allow-list).
- [ ] **Step 4: Run → PASS + full check** (run the prompt-eval-backed test).
- [ ] **Step 5: Commit** `feat(practice): next_rehearsal + current_setlist tools`

---

## Task 9: Final review + PR

- [ ] **Step 1:** AGENTS.md decisions entry (practice: rehearsals/availability/setlists tables, availability is a stored `!available` command not a poll [Discord sendPoll can't capture votes], LLM-free agenda, Discord-only binders, all `BAND_FEATURES_ENABLED`-gated). Commit.
- [ ] **Step 2:** If PR #225 has merged, rebase onto main (`git rebase --onto origin/main <band-memory-tip>`). Push `feat/remy-practice`; open PR against main. Body: what it delivers, the `!available`-not-poll decision, `BAND_FEATURES_ENABLED` usage, test evidence, follow-ups. Do NOT merge.

---

## Self-Review

**Spec coverage:** rehearsals + reminders (T1, T2, T7) ✓; availability stored + read-back (T3) ✓; setlists ordered (T4, T5) ✓; LLM-free agenda (T6) ✓; AI tools (T8) ✓; band gate everywhere (BAND_FEATURES_ENABLED in T2/T3/T5/T6/T8, EVENT_REMINDERS_ENABLED in T7) ✓; no-regression (flag default false) ✓; per-song status reused (no task — already in songs.status) ✓.
**Placeholder scan:** date parser (T2) is specified (accept `YYYY-MM-DD HH:MM` + relative, null on failure), not a vague TODO. FK-cascade note (T4) flags the sqlite `PRAGMA foreign_keys` check with a code-cleanup fallback.
**Type consistency:** `Rehearsal`/`RehearsalStatus`, `Availability`, `Setlist`/`SetlistSong`/`SetlistEntry`, barrel fn names, `handleRehearsalCommand`/`handleAvailabilityCommand`/`handleSetlistCommand`/`buildPracticeAgenda`/`handleAgendaCommand`, `scheduleDiscordRehearsalReminders`, the two tool names, and the config keys are used verbatim across tasks. `formatSongLine`/`getSongByTitle`/`parseTitleAndFields` reused from songs.ts. New tables added to `REQUIRED_CORE_TABLES`.
