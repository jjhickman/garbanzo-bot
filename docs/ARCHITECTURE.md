# Garbanzo Architecture

This document explains runtime data flow, routing decisions, and major subsystems.

## High-Level Components

- **Transport:** WhatsApp Web multi-device via Baileys socket
- **Entry + orchestration:** `src/index.ts`
- **Message dispatch:** `src/bot/handlers.ts` + `src/bot/group-handler.ts` + `src/bot/owner-commands.ts`
- **AI routing:** `src/ai/router.ts`
- **Cloud AI callers:** `src/ai/claude.ts` (OpenRouter/Anthropic), `src/ai/chatgpt.ts` (OpenAI fallback)
- **Local AI caller:** `src/ai/ollama.ts`
- **Shared provider payload/parsing:** `src/ai/cloud-providers.ts`
- **Persistence:** SQLite via `src/utils/db*.ts`
- **Cross-cutting middleware:** sanitize, context, stats, retry, health, logger

## Message Lifecycle

```text
WhatsApp message
  -> Baileys `messages.upsert`
  -> handlers.ts `registerHandlers` / `handleMessage`
      -> unwrap + extract text/media
      -> sanitize input
      -> record context/stats/profile activity
      -> moderation check (group-wide)
      -> route by message type:
           - introductions auto-response
           - events passive enrichment
           - acknowledgment reaction
           - group mention path
           - owner DM command path
      -> response send + stats update
```

### Handler Stages (group flow)

1. **Guards**: ignore fromMe/status broadcasts/stale messages
2. **Normalization**: unwrap message wrappers and extract text, mentions, quoted text
3. **Media/voice preprocessing**: transcribe voice notes, detect visual media
4. **Sanitization**: strip control chars, enforce limits, defang prompt-injection patterns
5. **Persistence**: context + message/profile/stats updates
6. **Moderation**: regex + OpenAI moderation layer; owner alerts and strike handling
7. **Feature routing**: bang command or natural language matching
8. **AI fallback route** when needed

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
  |      try Ollama (`qwen3:8b`)
  |      on failure -> cloud path
  |
  +-- cloud path:
         iterate providers in configured order (`AI_PROVIDER_ORDER`)
           - `openrouter`/`anthropic` -> `callClaude(provider, ...)`
           - `openai` -> `callChatGPT(...)`
         first successful provider returns response
```

### Cloud Reliability Controls

- **Per-request timeout:** 30s for Claude/OpenAI callers
- **Circuit breaker:** open for 60s after 3 consecutive failures
- **Cost tracking:** token-estimated cost entries in `stats.ts`
- **Daily alert threshold:** warning when estimated spend crosses configured threshold

## Multimedia Pipeline

Multimedia support spans `media.ts`, `voice.ts`, `links.ts`, and cloud vision payload builders.

### Images / Video / Stickers

```text
Message with media
  -> media.ts `extractMedia`
  -> media.ts `prepareForVision`
      - image/sticker/gif -> base64 image payload
      - video -> ffmpeg frame extraction (JPEG frames)
  -> ai/router.ts with `visionImages`
  -> cloud-providers.ts builds Anthropic/OpenAI-compatible content blocks
```

### Voice Notes

```text
PTT audio message
  -> media.ts `downloadVoiceAudio`
  -> voice.ts `transcribeAudio` (local Whisper-compatible API)
  -> transcript replaces message text for normal routing
```

### URL Understanding

```text
Message containing URL
  -> links.ts `processUrl`
     - YouTube: yt-dlp metadata + audio download -> Whisper transcription
     - Other URLs: fetch + HTML->text extraction
  -> extracted text added as context for AI response
```

### Text-to-Speech

- `voice.ts` uses Piper for synthesis and ffmpeg for output conversion when `!voice` commands are used.

## Data Model and Storage

SQLite database (`data/garbanzo.db`, WAL mode) stores:

- **messages**: chat history for context
- **moderation_log**: flags and strike history
- **daily_stats**: serialized digest snapshots
- **memory**: owner-curated long-term facts
- **member_profiles**: opt-in profile and activity metadata
- **feedback**: suggestions/bugs/upvotes

### Maintenance Jobs

- **Nightly backup**: `VACUUM INTO` snapshots in `data/backups/`
- **Retention prune**: message TTL cleanup + conditional VACUUM
- **Backup verification**: latest backup integrity reported via health endpoint

## Health and Operations

Health endpoint (`127.0.0.1:3001/health`) reports:

- connection state and staleness
- uptime/reconnect count
- memory usage
- latest backup integrity status

Operational protections:

- memory watchdog with restart threshold
- retry queue for transient AI failures
- process-level `unhandledRejection` / `uncaughtException` handlers
- basic health endpoint request rate limiting

## Security Boundaries

- secrets loaded from `.env` and validated via Zod (`config.ts`)
- input sanitization before routing
- moderation alerts are human-in-the-loop (owner DM)
- gitleaks scanning in pre-commit and `npm run check`

## Deployment Notes

- Default deployment: Docker Compose
- Alternative deployment: systemd user service on Terra (native Node)
- Do not run multiple bot instances against same Baileys auth state
