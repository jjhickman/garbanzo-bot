# Garbanzo Architecture

This document explains runtime data flow, routing decisions, and the major subsystems.

## High-Level Components

- Transport (primary): WhatsApp Web multi-device via Baileys
- Entry + orchestration: `src/index.ts` (starts health/maintenance, selects platform runtime)
- Platform runtime selection: `src/platforms/index.ts`
- Core pipeline (platform-agnostic):
  - `src/core/process-inbound-message.ts` (guards, sanitize, persistence, moderation, passive handlers)
  - `src/core/process-group-message.ts` (feature routing + AI response)
  - `src/core/response-router.ts` (bang commands + natural-language routing into AI/features)
- Messaging seams (platform adapters):
  - `src/core/messaging-adapter.ts` (sendText, sendMedia, etc.)
  - `src/core/platform-messenger.ts` (group feature sending: text, polls)
  - `src/core/message-ref.ts` / `src/core/poll-payload.ts` (explicit platform-opaque payloads)
- WhatsApp platform implementation: `src/platforms/whatsapp/*`
  - `runtime.ts`, `connection.ts`, `handlers.ts`, `processor.ts`
  - `adapter.ts`, `inbound.ts`, `media.ts`, `mentions.ts`, `reactions.ts`
  - `group-handler.ts`, `owner-commands.ts`, `digest.ts`, `introductions-catchup.ts`
- Slack scaffold (fail-fast, not production): `src/platforms/slack/*`
- AI routing: `src/ai/router.ts` (local Ollama vs cloud providers)
- Cloud AI callers: `src/ai/claude.ts`, `src/ai/chatgpt.ts`, `src/ai/gemini.ts` (if enabled)
- Shared cloud payload/parsing: `src/ai/cloud-providers.ts`
- Persistence: SQLite via `src/utils/db*.ts`
- Cross-cutting middleware: sanitize, context, stats, retry, health, logger, rate limiting

## Message Lifecycle

```text
WhatsApp message
  -> Baileys `messages.upsert`
  -> `src/platforms/whatsapp/handlers.ts` (socket event wiring)
  -> `src/platforms/whatsapp/processor.ts` (platform preprocessing)
       - normalize inbound message (`inbound.ts`)
       - voice transcription (if PTT)
       - build adapter (`adapter.ts`)
  -> `src/core/process-inbound-message.ts` (core pipeline)
       - transport guards (self/status/stale)
       - sanitization
       - persistence (context + profiles + stats)
       - moderation + owner escalation
       - passive handlers (introductions, events)
       - acknowledgment reactions
       - dispatch to:
           - `src/platforms/whatsapp/group-handler.ts` (mention parsing + media extraction)
             -> `src/core/process-group-message.ts` (feature routing + AI)
           - `src/platforms/whatsapp/owner-commands.ts` (owner DM commands)
```

### Core Pipeline Stages (group flow)

1. Guards: ignore fromSelf/status broadcasts/stale messages (introductions catch-up is exempt)
2. Normalization: unwrap platform wrappers into `InboundMessage` (text, quoted text, timestamps)
3. Media/voice preprocessing: transcribe voice notes; detect visual media
4. Sanitization: strip control chars, enforce length limits, defang prompt injection patterns
5. Persistence: context + message/profile/stats updates
6. Moderation: rules + (optional) external moderation; owner alerts and strike handling
7. Feature routing: bang commands or natural language matching
8. AI fallback route when needed

## AI Routing Decision Tree

`src/ai/router.ts` classifies each query and picks local vs cloud execution.

```text
Incoming query (+ optional vision images)
  |
  +-- if empty and no vision -> return null
  |
  +-- classifyComplexity(query, context)
  |
  +-- if simple AND no vision AND Ollama available:
  |      try Ollama
  |      on failure -> cloud path
  |
  +-- cloud path:
         iterate providers in configured order (`AI_PROVIDER_ORDER`)
           - `openrouter`/`anthropic` -> Claude-family caller
           - `openai` -> ChatGPT caller
           - `gemini` -> Gemini caller
         first successful provider returns response
```

### Cloud Reliability Controls

- Per-request timeouts in cloud callers
- Provider ordering + fallback via `AI_PROVIDER_ORDER`
- Cost tracking in `src/middleware/stats.ts`

## Multimedia Pipeline

### Images / Video / Stickers (vision)

```text
Message with visual media
  -> `src/platforms/whatsapp/media.ts` (download + extract)
  -> `src/core/vision.ts` (`prepareForVision` -> VisionImage[])
  -> `src/ai/router.ts` with `visionImages`
  -> `src/ai/cloud-providers.ts` builds provider content blocks
```

### Voice Notes

```text
PTT audio message
  -> `src/platforms/whatsapp/media.ts` (download audio bytes)
  -> `src/features/voice.ts` (`transcribeAudio`)
  -> transcript replaces message text for normal routing
```

### URL Understanding

```text
Message containing URL
  -> `src/features/links.ts` (`processUrl`)
     - YouTube: metadata + transcription
     - other URLs: fetch + extract text
  -> extracted summary is appended as context before AI response
```

### Text-to-Speech

- `src/features/voice.ts` uses Piper for synthesis and ffmpeg for output conversion when `!voice` commands are used.

## Data Model and Storage

SQLite stores:

- messages: chat history for context
- moderation_log: flags and strike history
- daily_stats: serialized digest snapshots
- memory: owner-curated long-term facts
- member_profiles: opt-in profile and activity metadata
- feedback: suggestions/bugs/upvotes

### SQLite Paths

- Production/dev default: `data/garbanzo.db` (WAL mode)
- Test runtime: a per-process DB lives under `os.tmpdir()` to avoid cross-worker locking and to prevent polluting the repo data directory.

### Maintenance Jobs

- Daily backup: `VACUUM INTO` snapshots in `data/backups/` (or the test temp dir)
- Retention prune: message TTL cleanup + conditional VACUUM
- Backup verification: latest backup integrity reported via health endpoint

## Health and Operations

Health endpoints (default bind `127.0.0.1:3001`):

- `GET /health`: status and diagnostics
- `GET /health/ready`: readiness semantics for monitoring (disconnect/staleness)

Operational protections:

- memory watchdog with restart threshold
- retry queue for transient AI failures
- process-level `unhandledRejection` / `uncaughtException` handlers
- if exposed beyond localhost (for monitoring), restrict access to trusted hosts

## Security Boundaries

- secrets loaded from `.env` and validated via Zod (`src/utils/config.ts`)
- input sanitization before routing
- moderation alerts are human-in-the-loop (owner DM)
- gitleaks scanning in pre-commit and `npm run check`

## Deployment Notes

- Default deployment: Docker Compose
- Alternative deployment: systemd user service (native Node)
- Do not run multiple bot instances against the same Baileys auth state
