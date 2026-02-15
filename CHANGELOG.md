# Changelog

All notable changes to Garbanzo are documented here.

## [Unreleased]

- (no entries yet)

> Note: older changelog sections include internal phase milestones that predate the current tagged release series.

## [0.1.2] — 2026-02-15

### Added

- **Slack demo runtime (local-only)** — run `MESSAGING_PLATFORM=slack` with `SLACK_DEMO=true` to exercise the core pipeline without Slack APIs (HTTP `/slack/demo` endpoint)

### Fixed

- **Readiness sticking stale after reconnect** — `/health/ready` no longer returns 503 with `stale=true` immediately after a successful WhatsApp reconnect
- **CI sqlite flakiness** — Vitest workers now use per-process sqlite DB paths under `os.tmpdir()` to avoid `SQLITE_BUSY` / WAL contention

### Changed

- **Core/platform refactor** — core inbound and group processing lives under `src/core/*`; WhatsApp runtime and platform-specific helpers live under `src/platforms/whatsapp/*`
- **Docs** — README and architecture docs updated to match current layout; Docker Hub overview updated with troubleshooting notes

## [0.1.1] — 2026-02-14

### Added

- Initial tagged release of Garbanzo.

### Notes

- The feature set that existed prior to the first tag is captured under "Historical Milestones" below.

## Historical Milestones (pre-tag)

### Phase 4 milestone — 2026-02-13

### Added — Phase 4: Growth Features
- **D&D 5e** — `!roll` dice rolling (any notation), `!dnd spell/monster/class/item` SRD lookups via dnd5eapi.co
- **Character sheet generator** — `!character [race] [class]` creates Level 1-20 D&D characters, fills official WotC PDF template (3 pages), supports named characters, alignment, background, free-form description
- **Book club** — `!book` search, author lookup, ISBN details via Open Library API
- **Venue search** — `!venue` search + details via Google Places API, Boston default
- **Polls** — `!poll Question / A / B / C` creates native WhatsApp polls (1-12 options, multi-select)
- **Fun features** — `!trivia`, `!fact`, `!today`, `!icebreaker` (40 Boston-themed icebreakers)
- **Feedback system** — `!suggest`, `!bug`, `!upvote` for member submissions; `!feedback` owner review

### Phase 3 milestone — 2026-02-13

### Added — Phase 3: Intelligence Layer
- **Ollama routing** — simple queries routed to local qwen3:8b, complex to Claude; auto-fallback
- **Conversation context** — SQLite-backed, last 15 messages per group as AI context
- **Daily digest** — auto-scheduled 9 PM summary to owner DM; `!digest` preview
- **Rate limiting** — per-user (10/5min) and per-group (30/5min) sliding window, owner exempt
- **Bang command routing** — `!weather`, `!transit`, `!news`, `!events`, `!help` alongside natural language
- **Persistent storage** — SQLite (`data/garbanzo.db`) for messages, moderation logs, daily stats
- **Strike tracking** — per-user strikes from moderation, soft-mute at 3+ strikes (30 min)

### Phase 2 milestone — 2026-02-13

### Added — Phase 2: Core Features
- **Weather** — current conditions + 5-day forecast via Google Weather API, Boston default + geocoding
- **MBTA Transit** — alerts, predictions, schedules with station/route aliases
- **Content moderation** — two-layer: regex patterns + OpenAI Moderation API, alerts to owner DM
- **New member welcome** — per-group tailored welcome on `group-participants.update`
- **News search** — top headlines and topic search via NewsAPI
- **Introduction responses** — AI-powered personal welcomes in Introductions group, 14-day catch-up
- **Emoji reactions** — reacts with bean emoji to short acknowledgments instead of full AI response
- **Event detection** — passive in Events group, composes weather + transit + Claude summary

### Phase 1 milestone — 2026-02-13

### Added — Phase 1: Minimum Viable Bot
- Baileys v6 WhatsApp connection with multi-device auth
- Claude AI responses via Anthropic/OpenRouter (Sonnet 4)
- @mention detection in 8 WhatsApp groups
- systemd user service for production deployment
- QR code scanning for initial auth
- Auth state persistence across restarts
- Auto-reconnect on disconnect
- Pino structured logging
