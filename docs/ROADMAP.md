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
6. [ ] **Character creation** (`src/features/character.ts`) — D&D 5e character sheet PDF generation via `pdf-lib`, fillable PDF template, stat calculation, Baileys document upload
7. [ ] **Release notes** — `!release` owner command, sends formatted "what's new" message to groups on major deployments

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

## Phase 5: Platform Expansion (Future)

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

## Phase 6: Advanced Intelligence (Future)

**Goal:** Deeper personalization and smarter community features.

### Tasks
1. [ ] **Member profiles** — track interests, event attendance, preferred topics per user (opt-in)
2. [ ] **Smart event recommendations** — suggest events based on member interests and past attendance
3. [ ] **Conversation summaries** — on-demand "what did I miss?" summaries for members catching up on group chat
4. [ ] **Multi-language support** — detect message language, respond in kind (leverage Claude's multilingual ability)
5. [ ] **Garbanzo memory** — long-term facts about the community ("last potluck was at X", "Y usually organizes hikes") stored in SQLite, surfaced in AI context
6. [ ] **Custom per-group personas** — slightly different tone/focus per group (e.g., more casual in General, more structured in Events)

### Gate
- [ ] Features add measurable value (members reference them, engagement metrics improve)
- [ ] AI costs remain sustainable
- [ ] Privacy controls are in place for any stored personal data

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
