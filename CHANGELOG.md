# Changelog

All notable changes to Garbanzo are documented here.

## [Unreleased]

### Added — Multimedia
- **Image/sticker/GIF understanding** — send media with @mention or reply to media, bot describes and responds via Claude Vision API
- **Video understanding** — extracts frames via ffmpeg, sends to Claude Vision for analysis
- **Voice message transcription** — incoming voice notes auto-transcribed via local Whisper (Speaches API on port 8090)
- **Voice replies** (`!voice`) — bot speaks text aloud using Piper TTS, 6 voices across 5 languages (English US/UK, Spanish, French, German, Portuguese), auto-selects voice based on detected language
- **YouTube transcription** — shared YouTube links auto-transcribed via yt-dlp + Whisper, summarized by Claude
- **URL understanding** — shared links fetched, content extracted, and summarized in AI context

### Added — Phase 6: Advanced Intelligence
- **Member profiles** (`!profile`) — opt-in interest tracking, display names, activity stats, `!profile delete` for data removal
- **Event recommendations** (`!recommend`, `!recs`) — Claude-powered suggestions based on member interests
- **Conversation summaries** (`!summary`, `!catchup`, `!missed`) — AI-generated summaries of recent group chat
- **Multi-language support** — detects 11 languages (Spanish, Portuguese, French, Italian, German, Chinese, Japanese, Korean, Arabic, Hindi, Russian), instructs Claude to respond in kind
- **Garbanzo memory** (`!memory`) — owner stores long-term community facts (venues, traditions, events) that persist in AI context
- **Custom per-group personas** — each WhatsApp group gets tailored bot personality via `config/groups.json`
- **Security hardening** — input sanitization middleware: control char stripping, 4096-char limit, prompt injection detection + defanging, JID validation
- **Context compression** — two-tier system: last 5 messages verbatim, older 25 extractively compressed with per-group caching (10-min TTL)

### Added — Phase 5: Operations & Reliability
- **Health check HTTP endpoint** — `GET http://127.0.0.1:3001/health` returns JSON status (connection, uptime, memory, staleness)
- **Connection staleness detection** — auto-reconnect if no messages for 30+ minutes
- **Ollama warm-up ping** — keep-alive every 10 minutes prevents model unload
- **SQLite auto-vacuum** — daily at 4 AM: prune messages >30 days + VACUUM
- **Cost tracking** — token estimation per Claude call, daily spend tracking, $1/day alert threshold
- **Feature flags per group** — optional `enabledFeatures` array in groups.json
- **Dead letter retry** — failed AI responses retried once after 30s (in-memory queue, max 50)
- **Automated SQLite backup** — nightly VACUUM INTO to `data/backups/`, 7-day retention
- **Memory watchdog** — warns at 500MB RSS, exits at 1GB (systemd restarts)
- **Graceful shutdown** — SIGTERM handler: clears retry queue, stops warmup/health/db timers

### Added — Phase 4 (completion)
- **Release notes** (`!release`) — owner broadcasts "what's new" to all groups or specific group

### Fixed
- **Introductions bug** — rewrote `looksLikeIntroduction()` from naive 40-char length check to signal-based classifier with strong/weak intro signals and negative filters
- **Japanese language detection** — reordered CJK script patterns so hiragana/katakana checked before Chinese characters (which overlap in Unicode range)
- **Empty interests edge case** — `!profile interests` with no arguments now shows error instead of blank profile
- **Memory add edge case** — `!memory add` with no arguments now shows usage instead of generic help

### Changed
- **PERSONA.md** — added "Bot Identity (Anti-Uncanny-Valley)" section: no fake experiences, no performative empathy, slight mechanical edge preferred
- **Help command** — updated with all Phase 6 commands, added separate owner help (`!help admin`)

## [0.4.0] — 2026-02-13

### Added — Phase 4: Growth Features
- **D&D 5e** — `!roll` dice rolling (any notation), `!dnd spell/monster/class/item` SRD lookups via dnd5eapi.co
- **Character sheet generator** — `!character [race] [class]` creates Level 1-20 D&D characters, fills official WotC PDF template (3 pages), supports named characters, alignment, background, free-form description
- **Book club** — `!book` search, author lookup, ISBN details via Open Library API
- **Venue search** — `!venue` search + details via Google Places API, Boston default
- **Polls** — `!poll Question / A / B / C` creates native WhatsApp polls (1-12 options, multi-select)
- **Fun features** — `!trivia`, `!fact`, `!today`, `!icebreaker` (40 Boston-themed icebreakers)
- **Feedback system** — `!suggest`, `!bug`, `!upvote` for member submissions; `!feedback` owner review

## [0.3.0] — 2026-02-13

### Added — Phase 3: Intelligence Layer
- **Ollama routing** — simple queries routed to local qwen3:8b, complex to Claude; auto-fallback
- **Conversation context** — SQLite-backed, last 15 messages per group as AI context
- **Daily digest** — auto-scheduled 9 PM summary to owner DM; `!digest` preview
- **Rate limiting** — per-user (10/5min) and per-group (30/5min) sliding window, owner exempt
- **Bang command routing** — `!weather`, `!transit`, `!news`, `!events`, `!help` alongside natural language
- **Persistent storage** — SQLite (`data/garbanzo.db`) for messages, moderation logs, daily stats
- **Strike tracking** — per-user strikes from moderation, soft-mute at 3+ strikes (30 min)

## [0.2.0] — 2026-02-13

### Added — Phase 2: Core Features
- **Weather** — current conditions + 5-day forecast via Google Weather API, Boston default + geocoding
- **MBTA Transit** — alerts, predictions, schedules with station/route aliases
- **Content moderation** — two-layer: regex patterns + OpenAI Moderation API, alerts to owner DM
- **New member welcome** — per-group tailored welcome on `group-participants.update`
- **News search** — top headlines and topic search via NewsAPI
- **Introduction responses** — AI-powered personal welcomes in Introductions group, 14-day catch-up
- **Emoji reactions** — reacts with bean emoji to short acknowledgments instead of full AI response
- **Event detection** — passive in Events group, composes weather + transit + Claude summary

## [0.1.0] — 2026-02-13

### Added — Phase 1: Minimum Viable Bot
- Baileys v6 WhatsApp connection with multi-device auth
- Claude AI responses via Anthropic/OpenRouter (Sonnet 4)
- @mention detection in 8 WhatsApp groups
- systemd user service for production deployment
- QR code scanning for initial auth
- Auth state persistence across restarts
- Auto-reconnect on disconnect
- Pino structured logging
