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
- [ ] Write the feature in its own file under `src/features/`
- [ ] Add command detection to the handler (e.g., "weather in Boston" → weather feature)
- [ ] Test with real messages in a single group
- [ ] Verify graceful degradation if API key is missing/invalid
- [ ] Run for 2+ days before adding next feature

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
- [x] **Ollama routing** — simple queries (greetings, FAQs, short answers) → local qwen3:8b, complex queries → Claude ✅ Live — complexity classifier, distilled persona for 8B, auto-fallback to Claude on failure
- [ ] **Conversation context** — include last 5 messages in group as context for AI responses
- [ ] **Daily digest** — summarize group activity, send to owner DM at 9 PM
- [ ] **Rate limiting** — per-user and per-group limits to prevent abuse
- [ ] **Feature command routing** — structured command parsing ("!weather Boston" vs natural language)
- [ ] **Persistent memory** — SQLite for user preferences, group stats, moderation history

### Gate ✅
- [ ] Ollama handles 50%+ of queries (confirmed via logs)
- [ ] Claude API costs reduced by measurable amount
- [ ] Digest provides actually useful daily summary
- [ ] Rate limiting prevents spam without blocking legitimate use

---

## Phase 4: Growth Features (Month 3+)

**Goal:** The fun stuff — only after the foundation is rock solid.

### Candidates (prioritize based on actual user requests)
- [ ] D&D 5e dice rolling and lookups
- [ ] Book club management (polls, reminders)
- [ ] Event planning with venue search
- [ ] Polls and voting
- [ ] Fun features (icebreakers, trivia, Boston fun facts)
- [ ] Discord bridge (if community expands there)

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
