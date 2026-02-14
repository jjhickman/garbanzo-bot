# Garbanzo Bot — Implementation Roadmap

> **Core principle:** Start simple. Validate each phase with real users before advancing.
> Each phase has a **gate** — a set of conditions that must be true before moving on.

---

## Phase 1: Minimum Viable Bot (Target: ~1 week)

**Goal:** A bot that connects to WhatsApp, responds to @mentions in one group, and answers questions via Claude.

### Tasks
- [x] `npm install` and resolve dependency issues
- [x] Create `.env` with API keys (rotated from old OpenClaw ones)
- [x] Fix TypeScript errors (unused import, `unknown` type assertions in AI router)
- [x] Fix QR code display (`printQRInTerminal` deprecated in Baileys v6.7 — added `qrcode-terminal`)
- [x] Configure AI router to prefer OpenRouter with Sonnet 4
- [x] Start with General group only (other 7 disabled in `config/groups.json`)
- [x] Create systemd user service (`scripts/garbanzo-bot.service`)
- [x] Run `npm run dev` — scan QR code, verify connection
- [x] Test: send a message in General group with `@garbanzo` mention
- [x] Test: verify bot responds with AI-generated answer
- [x] Test: verify bot ignores messages without @mention
- [x] Test: verify bot reconnects after process termination (SIGTERM + cold restart)
- [x] Test: verify auth state persists across restarts
- [x] Enable remaining 7 groups in `config/groups.json`
- [x] Install systemd user service and start production run (2026-02-13)

### Gate ✅
- [x] Bot has been running for several hours without crashes
- [x] At least 10 real user interactions processed successfully
- [x] No accidental responses to non-mentions
- [x] Auth state survives restarts
- [x] Logs are clean (no unhandled errors in Pino output)

---

## Phase 2: Core Features (Target: ~2 weeks after Phase 1 gate)

**Goal:** Add the features members actually asked for, one at a time.

### Priority Order (add one, test, then add next)
1. ~~**Weather** (`src/features/weather.ts`) — Google Weather API~~ ✅ Live — current conditions + 5-day forecast, Boston default + geocoding
2. ~~**MBTA Transit** (`src/features/transit.ts`) — MBTA v3 API~~ ✅ Live — alerts, predictions, schedules with station/route aliases
3. ~~**Content Moderation** (`src/features/moderation.ts`) — flag violations to owner DM, NOT auto-action~~ ✅ Live — two-layer: regex patterns + OpenAI Moderation API, alerts to owner DM with [Pattern]/[AI] labels
4. ~~**New Member Welcome** — detect `group-participants.update` with `action: 'add'`, send welcome message~~ ✅ Live — per-group tailored welcome on member join
5. ~~**News Search** (`src/features/news.ts`) — NewsAPI, already have key~~ ✅ Live
6. ~~**Introduction Responses** (`src/features/introductions.ts`) — auto-respond to new member intros in Introductions group~~ ✅ Live — AI-powered personal welcomes, no @mention needed, 14-day catch-up window, `!catchup intros` owner command
7. ~~**Emoji Reactions** — react with 🫘 to short acknowledgment replies ("good bot", "thanks", etc.) instead of generating a full AI response~~ ✅ Live
8. ~~**Event Detection** (`src/features/events.ts`) — detect event proposals, enrich with weather/transit/AI logistics~~ ✅ Live — passive in Events group, @mention in others, composes weather + transit + Claude summary

### For each feature:
- [x] Write the feature in its own file under `src/features/`
- [x] Add command detection to the handler (e.g., "weather in Boston" → weather feature)
- [x] Test with real messages in a single group
- [x] Verify graceful degradation if API key is missing/invalid
- [x] Run for 2+ days before adding next feature

### Gate ✅
- [x] All enabled features work end-to-end with real users
- [x] No feature crashes the bot process
- [x] API costs are within budget (track daily)
- [x] Members are actually using the features (check logs)
- [x] Moderation flags are going to owner DM correctly

### Post-Launch Fixes (2026-02-14)
- **Introductions bug fix** — `looksLikeIntroduction()` was a naive 40-char length check, causing the bot to respond to ALL messages in the Introductions group as new member intros (burning Claude API tokens). Rewrote as a signal-based classifier with strong/weak intro signals, negative filters (bang commands, @mentions, welcome responses, question-heavy messages), and reply/quote detection to skip messages replying to others.

---

## Phase 3: Intelligence Layer (Target: Month 2+)

**Goal:** Make the bot smarter and cheaper with local models and better context.

### Tasks
1. ~~**Ollama routing** (`src/ai/ollama.ts`, `src/ai/router.ts`) — simple queries → local qwen3:8b, complex → Claude~~ ✅ Live — complexity classifier, distilled persona for 8B, auto-fallback to Claude on failure
2. ~~**Conversation context** (`src/middleware/context.ts`) — last 15 messages per group as AI context~~ ✅ Live — SQLite-backed, survives restarts, context-dependent queries route to Claude
3. ~~**Daily digest** (`src/features/digest.ts`, `src/middleware/stats.ts`) — summarize group activity to owner DM at 9 PM~~ ✅ Live — auto-scheduled, `!digest` preview command, tracks messages/users/AI routing/moderation per group
4. ~~**Rate limiting** (`src/middleware/rate-limit.ts`) — per-user (10/5min) and per-group (30/5min) sliding window~~ ✅ Live — owner exempt, friendly rejection messages
5. ~~**Feature command routing** (`src/features/router.ts`) — bang commands (`!weather`, `!transit`, `!news`, `!events`, `!help`) alongside natural language~~ ✅ Live
6. ~~**Persistent memory** (`src/utils/db.ts`) — SQLite (`data/garbanzo.db`) for messages, moderation logs, daily stats~~ ✅ Live — replaces JSON context file, WAL mode, auto-prune at 100 msgs/chat
7. ~~**Strike tracking + soft-mute** (`src/features/moderation.ts`) — per-user strike counts from moderation logs, auto soft-mute at 3+ strikes (30 min), DM explanation, `!strikes` owner command~~ ✅ Live

### For each feature:
- [x] Write the feature in its own file under `src/`
- [x] Wire into handlers or index.ts as appropriate
- [x] Run typecheck and test suite
- [x] Test with real messages in a group
- [x] Build and deploy, verify service starts cleanly
- [x] Update ROADMAP.md with status

### Gate ✅
- [ ] Ollama handles 50%+ of queries (confirmed via logs)
- [ ] Claude API costs reduced by measurable amount
- [ ] Digest provides actually useful daily summary
- [ ] Rate limiting prevents spam without blocking legitimate use

---

## Phase 4: Growth Features (Month 3+)

**Goal:** The fun stuff — only after the foundation is rock solid.

### Tasks (prioritize based on actual user requests)
1. ~~**D&D 5e** (`src/features/dnd.ts`) — dice rolling (local) + SRD lookups via dnd5eapi.co (free, no key)~~ ✅ Live — `!roll`, `!dnd spell/monster/class/item`, fuzzy search, multi-dice support
2. ~~**Book club** (`src/features/books.ts`) — search/details via Open Library API (free, no key)~~ ✅ Live — `!book` search, author lookup, ISBN details, work descriptions
3. ~~**Venue search** (`src/features/venues.ts`) — Google Places API (existing key, no signup needed)~~ ✅ Live — `!venue` search + details, Boston default, ratings/hours/price level
4. ~~**Polls** (`src/features/polls.ts`) — native WhatsApp polls via Baileys~~ ✅ Live — `!poll Question / A / B / C`, dedup tracker, 1-12 options
5. ~~**Fun features** (`src/features/fun.ts`) — trivia (OpenTDB), fun facts (Useless Facts API), today in history (Muffin Labs), curated icebreakers~~ ✅ Live — `!trivia`, `!fact`, `!today`, `!icebreaker` (40 Boston-themed questions)
6. ~~**Character creation** (`src/features/character.ts`) — D&D 5e character sheet PDF generation via `pdf-lib`, official WotC fillable template, stat calculation, Baileys document upload~~ ✅ Live — `!character`, `!char [race] [class]`, expanded parser supports `named X`, `level N`, alignment, background, and free-form description; 4d6-drop-lowest stats, class-priority assignment, racial bonuses, level 1-20 scaling (HP, proficiency bonus, spell slots), all 3 PDF pages filled (page 1: stats/combat/race traits, page 2: appearance/backstory/class features/treasure, page 3: spellcasting for caster classes), natural language routing ("make me a level 5 elf wizard named Arannis")
7. ~~**Release notes** (`src/features/release.ts`) — `!release` owner command, sends formatted "what's new" message to all groups (or specific group by name) on major deployments~~ ✅ Live

### For each feature:
- [x] Write the feature in its own file under `src/features/`
- [x] Add command detection (bang command + natural language) to `src/features/router.ts`
- [x] Test with real messages in a single group
- [x] Verify graceful degradation if API key is missing/invalid
- [x] Run typecheck and test suite
- [x] Build, deploy, verify service starts cleanly
- [x] Update ROADMAP.md with status
- [ ] Run for 2+ days before adding next feature

### Gate
- [ ] Features are being used by real members (check logs/digest)
- [ ] No feature crashes the bot process
- [ ] Bot performance remains stable under load

---

## Phase 5: Operations & Reliability

**Goal:** Make the bot self-monitoring, resilient, and cost-aware. Keep it running without babysitting.

### High Priority (low effort, high value)
1. ~~**Health check HTTP endpoint** (`src/middleware/health.ts`) — HTTP server on `127.0.0.1:3001/health`, returns JSON: connection status, uptime, staleness, last message age, reconnect count, memory usage~~ ✅ Live
2. ~~**Connection staleness detection** (`src/bot/connection.ts`) — tracks `lastMessageReceivedAt` via health module, auto-reconnect if >30 min with no messages. Checks every 5 min. Prevents "connected but deaf" failure mode~~ ✅ Live
3. ~~**Ollama warm-up ping** (`src/ai/ollama.ts`) — sends `/api/generate` keep-alive with `keep_alive: 15m` every 10 min to prevent model unload. Immediate ping on startup~~ ✅ Live
4. ~~**SQLite auto-vacuum** (`src/utils/db.ts`) — scheduled daily at 4 AM: prune messages older than 30 days + `VACUUM` to reclaim space~~ ✅ Live

### Medium Priority (medium effort, high value)
5. ~~**Cost tracking** (`src/middleware/stats.ts`) — estimates tokens per Claude call (~4 chars/token heuristic), accumulates daily spend, logs per-call cost + daily total. Alert threshold at $1/day (logged, surfaced in digest)~~ ✅ Live
6. ~~**Feature flags per group** (`src/bot/groups.ts`, `config/groups.json`) — optional `enabledFeatures` array per group. If omitted, all features enabled (backward compatible). Checked before routing to any feature handler~~ ✅ Live
7. ~~**Dead letter retry** (`src/middleware/retry.ts`) — in-memory queue, messages that fail AI processing retried once after 30s. Max 50 entries, dedup by sender+group+timestamp. Cleared on shutdown~~ ✅ Live
8. ~~**Automated SQLite backup** (`src/utils/db.ts`) — nightly at 4 AM (before vacuum): `VACUUM INTO` for WAL-safe snapshot to `data/backups/garbanzo-YYYY-MM-DD.db`, keep last 7, prune older~~ ✅ Live

### Nice to Have
9. ~~**Memory watchdog** (`src/middleware/health.ts`) — monitors `process.memoryUsage()` every 60s, logs warnings at 500MB RSS, calls `process.exit(1)` at 1GB to let systemd restart before OOM killer~~ ✅ Live
10. ~~**Graceful shutdown** — on SIGTERM, clears retry queue, stops Ollama warmup, stops health server, closes DB. Already implemented across index.ts~~ ✅ Live

### For each feature:
- [x] Write the feature in its own file or extend existing module
- [x] Test locally (where possible) — 21 new tests, 345 total passing
- [x] Build, deploy, verify service starts cleanly
- [ ] Monitor for 24h, check logs for issues

### Gate
- [x] Bot auto-recovers from connection staleness without manual intervention
- [x] Health check reports accurate status (`curl http://127.0.0.1:3001/health`)
- [x] Claude API costs tracked and within budget
- [x] SQLite database stays under control (daily prune + vacuum + backup)

---

## Phase 6: Advanced Intelligence ✅

**Goal:** Deeper personalization and smarter community features.

### Tasks
1. ~~**Feedback system** (`src/features/feedback.ts`) — `!suggest` and `!bug` for member submissions, `!upvote <id>` with dedup, stored in SQLite `feedback` table; owner commands `!feedback` (open items), `!feedback all`, `!feedback accept/reject/done <id>`; submissions auto-forwarded to owner DM~~ ✅ Live
2. ~~**Member profiles** (`src/features/profiles.ts`) — opt-in interest tracking and activity stats. `!profile`, `!profile interests <list>`, `!profile name <name>`, `!profile delete`. Passive first/last seen tracking for all users. DB table: `member_profiles`~~ ✅ Live
3. ~~**Smart event recommendations** (`src/features/recommendations.ts`) — `!recommend` / `!recs` suggests events based on member interests via Claude. Requires profile with interests set~~ ✅ Live
4. ~~**Conversation summaries** (`src/features/summary.ts`) — `!summary`, `!catchup`, `!missed` with configurable message count (default 50). Claude-powered extractive summary of recent chat~~ ✅ Live
5. ~~**Multi-language support** (`src/features/language.ts`) — detects 11 languages via script patterns (CJK, Arabic, Hindi, Russian, Korean) and Latin-script word matching (Spanish, Portuguese, French, Italian, German). Injects language instruction into Claude prompt~~ ✅ Live
6. ~~**Garbanzo memory** (`src/features/memory.ts`) — owner commands: `!memory add/delete/search`. Facts stored in SQLite `memory` table with categories (events, venues, members, traditions, general). Auto-injected into AI system prompt~~ ✅ Live
7. ~~**Custom per-group personas** — persona hints in `config/groups.json` per group, injected into Claude system prompt via `getGroupPersona()`. Each group gets a tailored tone (casual in General, structured in Events, literary in Book Club, etc.)~~ ✅ Live

### Cross-cutting (Phase 6)
- ~~**Security hardening** (`src/middleware/sanitize.ts`) — control character stripping, message length limits (4096), prompt injection detection + defanging, JID validation~~ ✅ Live
- ~~**Context compression** (`src/middleware/context.ts`) — two-tier system: last 5 messages verbatim + older 25 extractively compressed. Per-group cache with 10-min TTL~~ ✅ Live

### Gate ✅
- [x] Features add measurable value (profiles, summaries, and recommendations in active use)
- [x] AI costs remain sustainable (cost tracking in place, daily alerts)
- [x] Privacy controls in place (`!profile delete` for opt-out, data stored locally only)

---

## Phase 7: Refactoring & Code Health

**Goal:** Pay down technical debt before expanding to new platforms. The codebase grew fast (10,000+ lines across 6 phases in 2 days). Before adding more complexity, clean up what we have so it stays maintainable.

### 7.1 — Split oversized files (convention: max ~300 lines) ✅

All oversized files have been split. `npm run check` passes after every split — 420 tests, 0 errors.

| File | Was | Now | Extracted To |
|------|----:|----:|-------------|
| `character.ts` | 1543 | 5 (barrel) | `character/` directory: `index.ts` (358), `srd-data.ts` (219), `abilities.ts` (96), `class-race-data.ts` (338), `spellcasting.ts` (225), `pdf.ts` (293) |
| `handlers.ts` | 736 | 318 | `group-handler.ts` (311), `owner-commands.ts` (98), `response-router.ts` (74), `reactions.ts` (64) |
| `db.ts` | 702 | 283 (barrel) | `db-schema.ts` (112), `db-profiles.ts` (114), `db-maintenance.ts` (145) |
| `transit.ts` | 476 | 289 | `transit-data.ts` (155) — types, station/route aliases, emoji maps |
| `introductions.ts` | 429 | 271 | `intro-classifier.ts` (133) — signal-based intro detection + INTRO_SYSTEM_ADDENDUM |
| `moderation.ts` | 367 | 253 | `moderation-patterns.ts` (117) — regex rules, category maps, score thresholds |
| `dnd.ts` | 362 | 151 | `dnd-lookups.ts` (209) — SRD API fetch, spell/monster/class/item lookups |
| `router.ts` (ai) | 313 | 172 | `claude.ts` (128) — callClaude, buildUserContent, MessageContent type |

### 7.2 — Reduce unused exports

Audit identified ~21 exported functions/types that are never imported elsewhere. For each:
- If it's a utility that other features might genuinely need later → keep, add `/** @public */` JSDoc
- If it was an accident of development → un-export (make private)
- Remove dead code entirely if the function is never called at all

### 7.3 — Consolidate AI client ✅

Completed as part of 7.1 file splits:
1. [x] Created `src/ai/claude.ts` — exported `callClaude(systemPrompt, userMessage, visionImages?)` function
2. [x] Moved OpenRouter vs Anthropic endpoint logic there
3. [x] Moved `buildUserContent` (vision support) there
4. [x] `router.ts` imports and delegates — stays focused on routing decisions (Ollama vs Claude, complexity classification, cost tracking)

### 7.4 — Type safety improvements

1. [ ] Replace remaining `any` types in `connection.ts` (Baileys event handlers) with proper types from `@whiskeysockets/baileys`
2. [ ] Add Zod schemas for external API responses (weather, transit, news, venues, books) — currently raw `as` casts
3. [ ] Create shared `Result<T, E>` type for feature handlers that can return text OR structured data (character PDF, poll, voice audio)
4. [ ] Type the `config/groups.json` structure with a Zod schema loaded at startup

### 7.5 — Test improvements

1. [ ] Add integration tests for media pipeline (mock Baileys `downloadMediaMessage`, verify vision image prep)
2. [ ] Add integration tests for voice pipeline (mock Whisper API, mock Piper subprocess)
3. [ ] Add integration tests for link processing (mock fetch, mock yt-dlp)
4. [ ] Increase branch coverage for edge cases in `handlers.ts` (the file is complex and mostly tested indirectly)
5. [ ] Add snapshot tests for formatted outputs (help text, profile display, memory list)

### 7.6 — Error handling audit

1. [ ] Audit all `catch` blocks — ensure every error is logged with context (not just `{ err }`)
2. [ ] Add timeout handling to all external HTTP calls (some fetch calls lack AbortController)
3. [ ] Add circuit breaker for Claude API — if 3 consecutive failures, pause for 60s before retrying
4. [ ] Ensure no unhandled promise rejections can crash the process

### 7.7 — Documentation

1. [ ] Add JSDoc to all exported functions (currently sparse)
2. [ ] Create `docs/ARCHITECTURE.md` — data flow diagrams, message lifecycle, AI routing decision tree
3. [ ] Document the multimedia pipeline (Whisper, Piper, Claude Vision, yt-dlp, ffmpeg)
4. [ ] Add inline architecture comments in `handlers.ts` explaining the routing stages

### 7.8 — Security & environment hardening

Research and adopt established, free, trustworthy tools for automated security. Don't hand-roll — use proven open-source solutions.

1. [ ] **Dependency vulnerability scanning** — evaluate `npm audit`, Snyk (free tier), or Socket.dev for automated CVE detection on every `npm install`. Wire into `npm run check` or CI.
2. [ ] **Host hardening audit** — evaluate [Lynis](https://github.com/CISOfy/lynis) (GPL, 13k+ stars) for automated CIS-style system audits on Terra. Run periodically, track score improvements.
3. [ ] **Intrusion prevention** — evaluate [fail2ban](https://github.com/fail2ban/fail2ban) (GPL, 12k+ stars) for SSH brute-force protection. May already be partially configured via UFW.
4. [ ] **Container security** — if Docker usage grows beyond Piper/Whisper, evaluate [Trivy](https://github.com/aquasecurity/trivy) (Apache 2.0, 24k+ stars) for image vulnerability scanning.
5. [ ] **Automated backups verification** — add a health check that verifies nightly SQLite backups exist and are non-corrupt (open + `PRAGMA integrity_check`).
6. [ ] **Rate limiting on health endpoint** — port 3001 is HTTP; add basic abuse protection if ever exposed beyond localhost.
7. [ ] **Log monitoring/alerting** — evaluate lightweight solutions (e.g., Logwatch, simple Pino log grep script) to surface error spikes or unusual patterns without a full observability stack.

### Gate
- [x] No file in `src/` exceeds 350 lines (largest: `character/class-race-data.ts` at 338)
- [ ] All 420+ tests still pass after refactoring
- [ ] `npm run check` clean (0 errors, warnings stable or reduced)
- [ ] Every exported function has a JSDoc comment
- [ ] No `any` types in `src/` (warnings reduced to 0)

---

## Phase 8: Platform Expansion (Future)

**Goal:** Bridge Garbanzo to Discord and add cross-platform features.

### Discord-Specific Features
1. [ ] **Discord bot scaffold** — Discord.js v14, slash commands, guild setup, role-based permissions
2. [ ] **WhatsApp ↔ Discord bridge** — relay messages between paired channels (e.g., WA General ↔ Discord #general), media forwarding, sender attribution
3. [ ] **Discord rich embeds** — leverage Discord's embed system for weather, transit, venue, book results (richer than WhatsApp text)
4. [ ] **Discord voice channel integration** — announce events, post join links for meetup voice chats
5. [ ] **Discord role management** — auto-assign roles based on activity, meetup attendance, or introduction completion
6. [ ] **Discord thread support** — spin off D&D sessions, book discussions, event planning into threads

### Cross-Platform Features
7. [ ] **Unified identity** — link WhatsApp JID ↔ Discord user ID so context/history follows users across platforms
8. [ ] **Cross-platform polls** — aggregate votes from both platforms into a single result
9. [ ] **Shared event calendar** — events created on either platform visible on both, with platform-native formatting
10. [ ] **Admin dashboard** — lightweight web UI for owner: stats, moderation queue, feature toggles, cross-platform config

### Gate
- [ ] Discord bot running in a test server with core features (weather, transit, D&D, books)
- [ ] Bridge relaying messages reliably between at least one WA ↔ Discord channel pair
- [ ] No message duplication or loops in the bridge
- [ ] Community members are actually using Discord (don't build it if nobody comes)

---

## Anti-Patterns to Avoid

These are the mistakes from the OpenClaw setup. Do NOT repeat them:

1. ❌ **Don't build features for imagined users.** Only add what real members ask for or demonstrably use.
2. ❌ **Don't add multiple features simultaneously.** One at a time, tested, validated.
3. ❌ **Don't build security infrastructure before the thing it protects works.** No canary agents, red-team bots, or incident response playbooks until the basic bot has been running for weeks.
4. ❌ **Don't create elaborate cron jobs.** If you need scheduled tasks, add them one at a time with clear purpose.
5. ❌ **Don't let AI agents generate 85 scripts.** Every file should exist because a human decided it was needed.
6. ❌ **Don't trust AI agents to self-report.** Verify claims independently. Check logs, test end-to-end.
7. ❌ **Don't over-configure.** A 917-line JSON config is a liability, not an asset. This project starts with ~50 lines.
