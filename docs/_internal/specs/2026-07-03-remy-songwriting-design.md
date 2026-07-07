# Remy Sub-project 3 — New Music / Songwriting — Design Spec

**Date:** 2026-07-03
**Status:** Draft (autonomous build; owner reviews at PR)
**Branch:** `feat/remy-songwriting` (stacked on `feat/remy-practice` / PR #226; rebase onto main after #226 merges)
**Part of:** Remy band-bot (foundation → band memory → practice → **songwriting**). Final planned sub-project.

## Summary

Help the band write and develop songs: capture ideas from chat **and from dropped audio clips** (transcribed via the existing Whisper server), organize each song into sections with lyrics and chords (seeding a future "Headchart" leadsheet), and move a song along the idea→demo→ready pipeline. All gated behind `BAND_FEATURES_ENABLED`, building on the `songs` table and the transcription/routing infra already in place.

## Goals

1. **Idea capture (text + audio):** `!idea` captures a song idea from a message; if the message (or the one it replies to) carries an audio clip, Remy fetches it, transcribes it via the existing `transcribeAudio` (Whisper), and stores the transcript + the clip URL with the idea. Ideas are listed, shown, and can be promoted into songs.
2. **Song sections / lyrics / chords:** `!section` and `!lyrics` build per-song structure (verse/chorus/bridge/…), each with lyrics and an optional chord line — the seed of the Headchart leadsheet model.
3. **idea→demo→ready pipeline:** reuse `songs.status` (`idea`→`rough`→`tight`→`gig-ready`); `!idea promote` turns an idea into a song (status `idea`) or links it to an existing one.
4. **Recall:** AI read tools (`get_song_sections`, `list_song_ideas`) + `!lyrics show` so the band and Remy can pull up a song's structure/lyrics.
5. **No regressions:** all flag-gated; community/WhatsApp bot byte-unaffected with `BAND_FEATURES_ENABLED=false`; the audio path degrades gracefully when the Whisper server is unreachable.

## Non-goals (deferred)

- **Live voice-channel recording / real-time capture** → later stretch (the roadmap's own note). This sub-project handles *dropped* clips only.
- **Persisting raw audio bytes / a blob store** → we store the transcript (DB text) + the Discord CDN attachment URL; we do NOT keep the audio file (no blob-storage infra exists and building it is out of scope). If the CDN URL later expires that's an accepted v1 limitation.
- **A rendered Headchart / chord-diagram UI** → we seed the data model (`song_sections.lyrics`/`chords`); rendering is future work.
- **AI-generated lyrics/melody** → out of scope; Remy organizes and recalls, it doesn't compose. (A future `!idea suggest` could call the AI path, but not here.)
- **Cross-platform audio (WhatsApp)** → WhatsApp already transcribes voice notes for its own path; Remy is Discord, so the new audio-drop wiring is Discord-only.

## Decisions

- **Audio capture is EXPLICIT, not automatic.** A band member drops a clip and runs `!idea [title]` (on the clip's message or a reply to it). We do NOT auto-transcribe every audio attachment in a channel — that would be surprising/noisy and conflicts with the project's "no autonomous behavior without sign-off" rule. (Auto-capture in a dedicated ideas channel is a possible future enhancement.)
- **Graceful degradation.** If `transcribeAudio` returns null (Whisper down/unreachable) or the fetch fails, the idea is still stored — with `audio_url` set and `transcript` null and a reply noting transcription wasn't available. The feature never hard-fails on a missing Whisper server.
- **Store transcript + CDN URL, not bytes.** `song_ideas.transcript` (DB text) + `song_ideas.audio_url` (Discord CDN url). No raw-file persistence.
- **Reuse `songs.status` as the pipeline.** No new status field; `!idea promote <id> [title]` creates a song (status `idea`) from an idea (or links via `song_id`), and the band advances it with the existing `!song set <title> status=…`.
- **Two new tables** (`song_ideas`, `song_sections`), following the established 8-sync-point pattern; `song_sections` is an FK-child of `songs` (model on `setlist_songs`: FK, `position`, in-code cascade in `deleteSong` since sqlite FKs are inert).
- **Discord attachment plumbing is additive.** Extend `InboundMessage` with an optional `audio?: { url: string; contentType: string }` (platform-agnostic, undefined on platforms that don't populate it). The Discord gateway surfaces the first `audio/*` attachment; WhatsApp/others are unaffected.
- **Reuse everything else:** `transcribeAudio` (voice.ts), band gate + routing + tool gating, `parseTitleAndFields`, `formatSongLine`/`getSongByTitle`.

## Architecture

```
drop audio + !idea  → Discord gateway surfaces audio attachment (url+contentType)
                        → InboundMessage.audio → dispatch → handleIdeaFeature
                        → fetch(url) → transcribeAudio(buffer) [graceful null]
                        → addSongIdea({title, text, audioUrl, transcript})
!idea list/show/promote  → src/features/song-ideas.ts
!section add/list/edit   → src/features/song-sections.ts (verse/chorus/bridge, lyrics, chords)
!lyrics show/set         → src/features/song-sections.ts (per-song lyrics view/edit)
        │
        ▼
song_ideas / song_sections tables (sqlite + postgres)
        │
get_song_sections / list_song_ideas (AI read tools, gated)
```

### Units / new schema

- **`song_ideas` table** — `{ id, title: string|null, text: string|null, audioUrl: string|null, transcript: string|null, songId: number|null (FK→songs, ON DELETE SET NULL / cleared in code), createdBy: string|null, createdAt }`. Backend: `addSongIdea(input)`, `getSongIdeaById(id)`, `listSongIdeas(limit?)`, `linkSongIdeaToSong(ideaId, songId)`, `deleteSongIdea(id)`.
- **`song_sections` table** — `{ id, songId (FK→songs), kind: 'intro'|'verse'|'chorus'|'bridge'|'solo'|'outro'|'other', position, lyrics: string|null, chords: string|null, createdAt, updatedAt }`, index on `(song_id, position)`. Backend: `addSongSection(input)`, `getSongSections(songId)` (ordered), `updateSongSection(id, patch)`, `moveSongSection(id, newPosition)` (transactional reorder like `moveSetlistSong`), `removeSongSection(id)` (gap-close). `deleteSong` also clears `song_sections` + nulls `song_ideas.song_id` (in code).
- **`src/features/song-ideas.ts`** — `handleIdeaCommand(args, ctx: { senderId; audio?: { url; contentType } }): Promise<string>` — `capture [title]` (uses ctx.audio if present → fetch+transcribe), `list`, `show <id>`, `promote <id> [title]` (→ addSong status idea + link), `delete <id>`. `formatIdeaLine(idea)`. A small `fetchAndTranscribe(url, contentType)` helper (guarded, returns null on any failure).
- **`src/features/song-sections.ts`** — `handleSectionCommand(args)` (`add <song> <kind> [lyrics=..] [chords=..]`, `list <song>`, `edit <song> <position> [lyrics=..] [chords=..]`, `move <song> <position> <newPosition>`, `remove <song> <position>`), `handleLyricsCommand(args)` (`show <song>` renders all sections' lyrics; `set <song> <kind> <lyrics...>` convenience). `formatSection(section)` / `formatSongSheet(song, sections)` (the Headchart seed: numbered sections with kind + lyrics + chords).
- **Core plumbing** — `InboundMessage.audio?`; Discord `gateway-client.ts` `mapMessageToPayload` surfaces the first `audio/*` attachment (`url` + `contentType`); `processor.ts` carries it into the inbound; `process-inbound-message.ts` / `process-group-message.ts` thread `audio` to the feature handler (alongside the existing `hasMedia`).
- **AI tools** — `get_song_sections` (param `title` → the song's sections/lyrics) and `list_song_ideas` (recent ideas), gated behind `BAND_FEATURES_ENABLED`.
- **Routing** — add `idea`/`section`/`lyrics` to the `feature` union + `BANG_COMMANDS`; handlers copy the `!song` gate. Mutations require owner/band member; `list`/`show` may be band-open.

## Config

- Reuse `BAND_FEATURES_ENABLED`. Audio uses the existing `WHISPER_URL` (default `http://127.0.0.1:8090`). No new keys required. (Owner must run the Speaches/Whisper server for transcription; without it, capture stores the clip URL only.)

## Error handling / degradation

- No audio on an `!idea capture` → store a text-only idea (title/text), fine.
- Audio present but fetch/transcribe fails → store the idea with `audioUrl` + `transcript=null`, reply noting transcription was unavailable. Never throw.
- Unknown idea/section/song refs, bad position, bad kind → friendly usage/not-found.
- Whisper timeout is already bounded (30s in `transcribeAudio`); the fetch gets its own timeout.
- All DB failures logged (Pino), never crash the reply path.

## Testing

- **DB layers:** song_ideas CRUD + link + list; song_sections CRUD + ordered get + transactional reorder + gap-close; `deleteSong` clears sections + nulls idea links (in code, sqlite FKs inert). Postgres via typecheck + gated integration test.
- **Feature handlers:** each `!idea`/`!section`/`!lyrics` subcommand incl. not-found, bad input, promote-creates-song, the audio-capture path with a MOCKED fetch + mocked `transcribeAudio` (success AND null-degradation).
- **Audio plumbing:** gateway surfaces an `audio/*` attachment into `InboundMessage.audio` (mock a discord.js message with an audio attachment); non-audio attachments don't populate it; WhatsApp path unaffected (audio undefined).
- **Tools:** `get_song_sections`/`list_song_ideas` gated off when `BAND_FEATURES_ENABLED=false`.
- **Regression:** full suite green; community/WhatsApp byte-unaffected with the flag off; prompt-eval set green (tools.ts change); no real network in tests (mock fetch + transcribeAudio).

## Rollout / what the owner provides

With `BAND_FEATURES_ENABLED=true`: `!idea capture <title>` (optionally on a message with an audio clip), `!section add <song> chorus lyrics=... chords=...`, `!lyrics show <song>`, `!idea promote <id>`. For audio transcription, run the Speaches/Whisper server and set `WHISPER_URL` (else clips are stored as links without transcripts). Rollback: `BAND_FEATURES_ENABLED=false`.

## Open questions (proceeding on stated defaults; owner can redirect at PR)

1. Explicit `!idea` capture vs auto-transcribe any dropped clip — proceeding with **explicit** (no surprise autonomous transcription); auto-capture-in-a-channel is a possible later enhancement.
2. Persist raw audio vs transcript+URL — proceeding with **transcript + CDN URL only** (no blob store); accepts eventual CDN-URL expiry.
3. Section `kind` set — proceeding with intro/verse/chorus/bridge/solo/outro/other (CHECK-constrained); extensible later.
