# Remy Sub-project 2 — Practice / Rehearsal — Design Spec

**Date:** 2026-07-03
**Status:** Draft (autonomous build; owner reviews at PR)
**Branch:** `feat/remy-practice` (stacked on `feat/remy-band-memory` / PR #225; rebase onto main after #225 merges)
**Part of:** Remy band-bot (foundation → band memory → **practice** → songwriting).

## Summary

Help the band actually rehearse: schedule rehearsals with reminders, collect who's coming, build setlists from the song catalog, and get an auto-generated practice agenda (what needs work + what's next). Everything is gated behind the existing `BAND_FEATURES_ENABLED` flag and builds on sub-project 1's `songs` table and the foundation's Discord scheduler infra. Per-song status tracking (`idea/rough/tight/gig-ready`) already shipped in sub-project 1 — this sub-project is about coordinating the practice itself.

## Goals

1. **Rehearsals:** schedule/list/show/cancel rehearsals (date, location, agenda note); a Discord reminder fires ahead of each one (reusing the event-reminder scheduler pattern).
2. **Availability:** band members respond `!available <rehearsal> yes|no|maybe`, and anyone can read back who's coming — done with a real stored table, NOT a poll (see Decisions).
3. **Setlists:** create named, ordered setlists that reference songs from the catalog; add/remove/reorder/show; a setlist knows each song's key/tempo/status via the FK.
4. **Practice agenda:** an auto-generated, LLM-free agenda (songs needing work via `songs.status`, the next rehearsal, the current setlist) available on demand (`!agenda`) and optionally auto-posted on a schedule.
5. **No regressions:** all of it flag-gated; the community/WhatsApp bot is byte-unaffected with `BAND_FEATURES_ENABLED=false`.

## Non-goals (deferred)

- **Song sections / lyrics / charts / audio** → sub-project 3 (songwriting).
- **Show/gig logistics** (stage plot, input list, load-in, booking) → sub-project 4 (shows), parked.
- **Cross-platform (WhatsApp) practice features** → Remy is Discord-only (the band gate `senderIsBandMember` is Discord-populated; per the Decisions Log Remy deploys on Discord). Practice schedulers/commands bind on the Discord runtime only; the shared builders stay platform-agnostic so a WhatsApp path could be added later.
- **Attendance analytics / streaks** → later, once there's data.

## Decisions

- **Availability is a stored `!available` command, NOT a poll.** The platform poll primitive (`sendPoll`) is fire-and-forget with no vote storage, and — critically — the **Discord adapter's `sendPoll` is a numbered-text stub with zero vote capture** (`src/platforms/discord/adapter.ts`). To read back "who's coming Thursday?" we must store responses. So availability is an explicit `!available <rehearsal-ref> yes|no|maybe` command writing to an `availability` table, with a read-back in `!rehearsal show`. (A future enhancement could collect Discord reaction events, but the command is unambiguous and testable now.)
- **Rehearsals get a dedicated table**, not reused `event_reminders`. A rehearsal carries agenda + notes + attendance and is referenced by availability rows and setlists — richer than the fire-once `event_reminders` shape. The rehearsal reminder REUSES the scheduler mechanism (a Discord poller that sends a reminder ahead of `scheduled_at` and marks it sent), mirroring `scheduleDiscordEventReminders`.
- **Setlists = two tables** (`setlists` + `setlist_songs` join with `position`), because ordering/grouping isn't expressible in the flat `songs` table. `setlist_songs.song_id` FKs `songs`; deleting a song cleans up its setlist entries.
- **The practice agenda is a pure, LLM-free builder** (like `buildWeeklyRecap`) so it works with all AI providers down: it reads `listSongs('rough')`/`listSongs('idea')`, the next rehearsal, and the current setlist, and formats markdown.
- **Reuse, don't reinvent:** per-song status = `songs.status` (sub-project 1, unchanged); command routing + owner/band gate = copy the `!song` path; scheduler = the option-B pure-builder + Discord binder split; AI read tools = copy the `list_band_songs` gating.
- **Band gate everywhere:** every new command/tool/scheduler is gated by `BAND_FEATURES_ENABLED`; mutations require owner OR band member (`senderIsBandMember`), exactly like `!song`.

## Architecture

```
!rehearsal schedule/list/show/cancel/note  → src/features/rehearsals.ts
!available <rehearsal> yes|no|maybe         → src/features/rehearsals.ts (availability)
!setlist create/add/remove/move/show       → src/features/setlists.ts
!agenda                                     → src/features/practice-agenda.ts (pure builder)
        │                                            │
        ▼                                            ▼
rehearsals / availability / setlists / setlist_songs tables (sqlite + postgres)
        │                                            │
scheduleDiscordRehearsalReminders (binder) ──┐   list_band tools pattern
scheduleDiscordPracticeAgenda (optional)  ───┘   → next_rehearsal / current_setlist (AI tools, gated)
        │
   bound in src/platforms/discord/runtime.ts (disposers)
```

### Units / new schema

- **`rehearsals` table** — `{ id, scheduled_at (unix s), location: string|null, agenda: string|null, status: 'scheduled'|'done'|'cancelled', reminder_sent: 0|1, created_by, created_at, updated_at }`. Backend: `addRehearsal`, `getRehearsalById`, `listUpcomingRehearsals(nowSeconds, limit?)`, `getNextRehearsal(nowSeconds)`, `updateRehearsal(id, patch)`, `cancelRehearsal(id)`, `listRehearsalsNeedingReminder(nowSeconds)` + `markRehearsalReminderSent(id)`.
- **`availability` table** — `{ id, rehearsal_id (FK), member_id, member_name: string|null, response: 'yes'|'no'|'maybe', responded_at }`, UNIQUE(rehearsal_id, member_id) so a re-vote updates. Backend: `setAvailability(rehearsalId, memberId, memberName, response)` (upsert), `listAvailability(rehearsalId)`.
- **`setlists` table** — `{ id, name (unique-ish, case-insensitive), notes: string|null, created_at, updated_at }`. **`setlist_songs`** — `{ id, setlist_id (FK), song_id (FK), position }`, UNIQUE(setlist_id, position). Backend: `addSetlist`, `getSetlistByName`, `listSetlists`, `addSongToSetlist(setlistId, songId, position?)`, `removeSongFromSetlist(setlistId, songId)`, `moveSetlistSong(setlistId, songId, newPosition)`, `getSetlistSongs(setlistId)` (joined to `songs`, ordered), `deleteSetlist`.
- **`src/features/rehearsals.ts`** — `handleRehearsalCommand(args, ctx)` and `handleAvailabilityCommand(args, ctx)` (ctx carries senderId/senderName for availability). Reuse `parseTitleAndFields` from `songs.ts` for `when=`/`location=`/`agenda=` tokens. `formatRehearsalLine(r)`.
- **`src/features/setlists.ts`** — `handleSetlistCommand(args)`; `formatSetlist(setlist, songs)` rendering ordered `formatSongLine`-style entries.
- **`src/features/practice-agenda.ts`** — `buildPracticeAgenda(now): Promise<string>` (pure, LLM-free) + `handleAgendaCommand()`.
- **Scheduler** — `scheduleDiscordRehearsalReminders(messenger)` in `src/platforms/discord/schedulers.ts` (mirror `scheduleDiscordEventReminders`: poll `listRehearsalsNeedingReminder` → `messenger.sendText` to the rehearsal's channel/owner → `markRehearsalReminderSent`), gated by a `REHEARSAL_REMINDERS_ENABLED` (or reuse `EVENT_REMINDERS_ENABLED`) flag; optionally `scheduleDiscordPracticeAgenda(messenger, targetChannelId)` weekly. Bound in `runtime.ts` disposers.
- **AI tools** — `next_rehearsal` and `current_setlist` in `tools.ts`, gated behind `BAND_FEATURES_ENABLED` in `getEnabledTools`.
- **Routing** — add `rehearsal`/`available`/`setlist`/`agenda` to the `feature` union + `BANG_COMMANDS`; each handler in `process-group-message.ts` copies the `!song` `BAND_FEATURES_ENABLED` + owner/band gate. Read-only subcommands (`list`/`show`/`agenda`) may be allowed for anyone in a band channel; mutations require owner/band member.

## Config

- Reuse `BAND_FEATURES_ENABLED` (gates all of it). Optional `DISCORD_PRACTICE_CHANNEL_ID` for agenda auto-post; rehearsal reminders reuse `EVENT_REMINDERS_ENABLED` + the rehearsal's target channel (fall back to owner DM). Reminder lead time: a `REHEARSAL_REMINDER_LEAD_MINUTES` (default ~120) mirroring the event lead.

## Error handling / degradation

- Unknown subcommands / bad dates / unknown rehearsal or setlist refs → friendly usage strings, no throw.
- `!available` for a cancelled/past rehearsal → decline with a clear message.
- Setlist ops on a missing song/setlist → not-found message.
- Agenda with no data (no songs/rehearsals) → a friendly "nothing scheduled" rather than an empty post.
- All DB failures logged (Pino), never crash the reply path. Scheduler ticks catch per-item errors (mirror the event-reminder poller).

## Testing

- **DB layers** (both backends' shared-layer test): rehearsals CRUD + needing-reminder/mark-sent; availability upsert + list; setlists + setlist_songs ordering/reorder/remove + join-to-songs + cascade on song delete. Postgres path structurally covered (typecheck + gated integration test) like `songs`.
- **Feature handlers:** each `!rehearsal`/`!available`/`!setlist`/`!agenda` subcommand incl. bad input, not-found, owner/band gate.
- **Scheduler:** `scheduleDiscordRehearsalReminders` fires a reminder at the right time via fake timers, marks sent, doesn't double-send, disposer stops it (mirror the event-reminder test).
- **Tools:** `next_rehearsal`/`current_setlist` gated off when `BAND_FEATURES_ENABLED=false`.
- **Regression:** full suite green; community/WhatsApp path unaffected with the flag default off; prompt-eval set green (tools.ts changes).

## Rollout / what the owner provides

With `BAND_FEATURES_ENABLED=true`, band members use `!rehearsal schedule when=... location=...`, `!available <rehearsal> yes`, `!setlist create ...` / `!setlist add ...`, `!agenda`. Optionally set `DISCORD_PRACTICE_CHANNEL_ID` for the weekly agenda auto-post. Rollback: `BAND_FEATURES_ENABLED=false`.

## Open questions (proceeding on stated defaults; owner can redirect at PR)

1. Availability via `!available` command vs Discord reactions — proceeding with the **command** (Discord `sendPoll` can't capture votes); reactions are a possible later enhancement.
2. Rehearsal date parsing — proceed with a small explicit parser (`when=YYYY-MM-DD HH:MM` + a few relative forms like `when=thu 19:00`); natural-language date parsing can come later. Reuse the event timestamp-resolution helper if it fits.
3. Practice-agenda auto-post cadence — proceed with an on-demand `!agenda` first; the scheduled auto-post is included but off unless `DISCORD_PRACTICE_CHANNEL_ID` is set.
