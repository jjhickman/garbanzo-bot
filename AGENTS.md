# AGENTS.md — Garbanzo

## Project Overview

**Garbanzo** is a multi-platform community bot. Discord (official Gateway API) is the first-class default platform; WhatsApp (via the Baileys unofficial WhatsApp Web API) is fully supported and runs the original 120+ member Boston-area meetup deployment. Platform adapters sit behind a shared abstraction (`src/core/` + `src/platforms/`), and instances compose via docker profiles. Messages route to AI models via a configurable cloud failover order (`AI_PROVIDER_ORDER`) plus local Ollama for simple queries.

The bot's persona is **Garbanzo Bean** 🫘 — a warm, direct, Boston-savvy community connector.

## Stack

- **Runtime:** Node.js 20+ with TypeScript (ES Modules)
- **WhatsApp:** `@whiskeysockets/baileys` v7 (multi-device, socket-based)
- **AI:** Configurable cloud failover order (`AI_PROVIDER_ORDER`) + Ollama (local for simple queries)
- **Validation:** Zod for runtime type checking
- **Logging:** Pino
- **Testing:** Vitest
- **Build:** `tsc` → `dist/`, dev via `tsx watch`
- **Default deployment:** Docker Compose (`docker compose up -d`)

## Development Principles

### Use existing tools first — don't hand-roll what exists

Before implementing any feature, task, or utility, **research whether a reliable, free, and trustworthy existing tool, library, or API already solves the problem.** Only write custom code when no suitable option exists or when the existing options are unreliable, unmaintained, or introduce unacceptable dependencies.

**Process for every new feature or task:**

1. **Research first** — Search for established open-source tools, npm packages, system utilities, or free APIs that address the need. Evaluate by: GitHub stars/maintenance activity, license (prefer MIT/Apache/BSD), dependency footprint, community trust.
2. **Evaluate fit** — Does the tool cover 80%+ of the requirement? Is it actively maintained (commits in the last 6 months)? Does it have a reasonable dependency tree? Is it free for our use case?
3. **Propose before building** — Present the option to the developer with a brief rationale (what it does, why it's better than hand-rolling, any tradeoffs). Get approval before adding dependencies.
4. **Fall back to custom only when justified** — If no suitable tool exists, the options are abandoned/unmaintained, the dependency cost is too high, or the requirement is truly project-specific, then write custom code.

**Examples of this principle in action:**
- Secret scanning → **gitleaks** (MIT, 17k+ stars, 150+ detectors) instead of custom regex script
- WhatsApp API → **Baileys** instead of raw WebSocket implementation
- Schema validation → **Zod** instead of hand-written validators
- Logging → **Pino** instead of custom logger
- Speech-to-text → **Whisper API** (local Speaches server) instead of custom audio processing
- Text-to-speech → **Piper** (native binary) instead of custom synthesis
- YouTube download → **yt-dlp** instead of custom scraper

**This principle applies equally to AI agents working on this codebase.** When an agent is tasked with implementing something, it should research existing solutions before writing code. The agent should present options and let the developer choose.

### Security: Credential Audit

All code changes are scanned for hardcoded secrets before they can be committed or pushed. This is enforced at three levels:

1. **Pre-commit hook** — `gitleaks git --staged` runs automatically on every `git commit`. Blocks commits containing API keys, tokens, private keys, personal emails, or other secrets/PII. Install hooks with `npm run setup:hooks`.
2. **`npm run check`** — The full pre-commit check pipeline (`audit:secrets` → `typecheck` → `lint` → `test`) includes a gitleaks scan of the working directory. Run this before every commit.
3. **`npm run audit:secrets`** — Standalone secret scan. Use `--verbose` for detailed findings, `--staged` for only staged files.

**Configuration:** `.gitleaks.toml` at project root. Built-in rules detect 150+ secret types. Custom rules added for WhatsApp JIDs and personal email addresses. Allowlists configured for files that legitimately reference patterns (docs, examples, config).

**If gitleaks flags a finding:**
- Move the secret to `.env` (gitignored)
- Reference via `process.env.VAR_NAME` in code
- For test files, use fake values (`test_key_xxx`, `5550001234`)
- For genuine false positives, add an inline `gitleaks:allow` comment or update `.gitleaks.toml` allowlist

### PII Guard: No Personal Contact Information in Code

**Never commit personal email addresses, phone numbers, or private contact details to the repository.** This rule is enforced by both the `pii-personal-email` gitleaks rule and the pre-commit hook.

- **Public contact channels only** — Use GitHub Issues, Discussions, or project-level email addresses for any contact links in websites, docs, or config files. Never use personal inboxes.
- **The gitleaks `pii-personal-email` rule** blocks commits containing emails from private providers (ProtonMail, Tutanota, iCloud, Fastmail, etc.). See `.gitleaks.toml` for the full list.
- **If you need to reference a maintainer** — link to their GitHub profile, not their personal email.
- **AI agents must never** output, embed, or commit personal identifying information (names, emails, phone numbers, addresses) into any file unless the owner explicitly instructs them to do so in that specific conversation.

## Commands

```bash
# Install dependencies
npm install

# Development (hot-reload)
npm run dev

# Interactive setup wizard (platform/provider order/models/features/persona/groups)
npm run setup

# Type-check without emitting
npm run typecheck

# Run linter
npm run lint

# Run tests
npm run test

# Scan for hardcoded secrets
npm run audit:secrets

# Install git hooks (pre-commit PII/secret scanning)
npm run setup:hooks

# Build for production
npm run build

# Start production
npm run start

# Full pre-commit check (secrets + typecheck + lint + test)
npm run check

# Release dry-run validation before tagging
npm run release:plan

# GitHub account workflow helpers
npm run gh:status
npm run gh:dependabot
npm run gh:switch:author
npm run gh:switch:owner
npm run gh:whoami

# Rotate GitHub Actions secrets from local env vars
npm run rotate:gh-secrets
```

## Project Structure

File-level layout changes often — trust the directory purposes, explore the live tree, and use the Decisions Log below as authoritative context.

```text
src/core/ - platform-agnostic inbound and outbound message pipeline.
src/platforms/<name>/ - one adapter plus runtime per platform.
src/bridge/ - cross-instance relay: capture to outbox to transport to deliver.
src/ai/ - AI routing, provider integrations, persona loading, and tools.
src/features/ - feature modules, usually one file per feature.
src/middleware/ - health, admin, rate-limit, context, retry, and request safety layers.
src/utils/ - shared persistence, formatting, RAG/vector, embedding, reranking, and support utilities.
src/utils/config/ - modular environment schema and config validation.
config/ - runtime JSON config families for Discord channels, bridge map, RAG sources, and WhatsApp groups.
docs/ - operator docs, architecture notes, runbooks, personas, and docs/_internal/ process records.
deploy/helm/ - Kubernetes Helm deployment assets.
monitoring/ - self-hosted Prometheus and Grafana stack.
tests/ - Vitest suites and prompt evals.
website/ - garbanzobot.com static site.
scripts/ - setup, release, audit, account, and operations helpers.
```

## Decisions Log

Settled questions — **do not relitigate these**; propose a change only with new evidence, and note it here when a decision changes.

- **OpenAI is the primary AI provider** (owner decision, 2026-06). Anthropic/Gemini/Bedrock/Ollama are failover via `AI_PROVIDER_ORDER`. When an integration misbehaves, fix the integration — do not propose switching primary provider.
- **Production models: `gpt-5.4-mini` primary, `claude-haiku-4-5` fallback, prompt caching on** (2026-07-01).
- **One process = one platform** (`MESSAGING_PLATFORM`). Discord is the first-class default platform through the official API; WhatsApp is fully supported through unofficial Baileys with documented account-risk safety; instances compose via platform profiles.
- **Discord runs a real discord.js Gateway** (opt-in channels, `requireMention` default true); owner model = `DISCORD_OWNER_ID` (user id) + resolved DM channel for escalation; schedulers/welcome bound in the Discord runtime; WhatsApp login bootstrap is whatsapp-only.
- **Platform-named infra is the v2 model**: compose profiles/services/jobs/env files are `discord`, `whatsapp`, and `monitoring`; persona names such as Remy do not name infrastructure.
- **Persona identity is file-driven**: `getPersonaName()` derives display identity from the loaded persona document; personas are configurable, and Garbanzo is the framework name.
- **Layered env files + `COMPOSE_PROFILES` are the deployment model**: `.env` holds shared values, `.env.discord` and `.env.whatsapp` hold instance deltas, and Docker/native runs apply the same layering.
- **Remy band features are gated behind `BAND_FEATURES_ENABLED`** (default false → community/WhatsApp bot unaffected). The band knowledge base adds ONE structured table (`songs`: title/key/tempo/status[idea|rough|tight|gig-ready]/notes) — the keystone for practice/songwriting — while members/gear/decisions/gigs REUSE the existing memory+Qdrant fact pipeline (no new fact infra). `!song` (add/list/show/set/delete) routes through the shared group dispatch, gated on owner OR Discord band-member (roles plumbed from the gateway as `senderRoleIds` → `isBandMember`; core never imports discord-config). Read tools `list_band_songs`/`find_band_song` + a bounded catalog block in the system/Ollama prompt are all flag-gated. Deploy Remy as band mode on the Discord profile with `.env.discord`, `BAND_FEATURES_ENABLED=true`, and optional `remy_memory`; `npm run setup` provisions the split env files.
- **Remy practice features** (sub-project 2, all `BAND_FEATURES_ENABLED`-gated) add four tables following the `songs` 8-sync-point pattern: `rehearsals` (+ `!rehearsal` schedule/list/show/cancel/note + a Discord 5-min reminder poller + optional weekly agenda auto-post), `availability` (+ `!available <id> yes|no|maybe` — a STORED command, NOT a poll, because Discord's `sendPoll` is a text stub that can't capture votes; read back in `!rehearsal show`), and `setlists`+`setlist_songs` (+ `!setlist` create/add/remove/move/show referencing songs). `!agenda` is a pure LLM-free builder (mirrors `buildWeeklyRecap`). AI tools `next_rehearsal`/`current_setlist` gated. sqlite runs WITHOUT `PRAGMA foreign_keys=ON`, so FK `ON DELETE CASCADE` is inert — cascade cleanup is done IN CODE (`deleteSong`/`deleteSetlist` clear `setlist_songs`); rehearsals are soft-cancelled, never hard-deleted. Follow-ups: availability read-back shows raw Discord IDs (needs display-name plumbing), scheduler binders gate on `EVENT_REMINDERS_ENABLED` not the band flag.
- **Remy songwriting features** (sub-project 3, all `BAND_FEATURES_ENABLED`-gated) add `song_ideas` + `song_sections` tables. **Discord audio-attachment capture is greenfield here:** `InboundMessage.audio?: {url, contentType}` is populated by the Discord gateway (first `audio/*` attachment by content-type or `.m4a/.ogg/.mp3/.wav/.webm` extension) and threaded through the dispatch — Discord previously discarded all attachments. `!idea capture` stores a song idea from text OR a dropped clip: it `fetch()`es the CDN url and transcribes via the existing `transcribeAudio` (Whisper/Speaches at `WHISPER_URL`), storing the transcript + audio url. **It degrades gracefully** — if the Whisper server is unreachable / fetch fails / transcript is null, the idea is still stored (audio url set, transcript null); the audio path NEVER crashes the reply. We store the transcript + Discord CDN url, NOT raw audio bytes (no blob store). `!idea promote` creates a song (`status: 'idea'`) — the idea→demo→ready pipeline reuses `songs.status`, no new field. `!section`/`!lyrics` build per-song structure (kind/lyrics/chords → `formatSongSheet`, the Headchart seed). AI tools `get_song_sections`/`list_song_ideas` gated. `deleteSong` also clears `song_sections` + nulls `song_ideas.song_id` in code (sqlite FK inert). WHISPER_URL is the only new (optional) external dependency. Deferred: live voice-channel recording, blob storage, AI-generated lyrics.
- **Web search is multi-provider with priority Firecrawl → Brave → Google PSE → SearXNG** (PRs #216, #220). `web_search` tool results get a 6,000-char budget vs 1,500 for other tools, to allow extracted page content.
- **The system prompt must explicitly direct models to prefer tools over training data** (PR #218) — without it, models answer factual questions from stale memory. Preserve this directive in any prompt rewrite.
- **Storage: SQLite is the default backend**; Postgres exists behind `db-backend.ts` (runbook: `docs/POSTGRES_MIGRATION_RUNBOOK.md`).
- **Vector memory: self-hosted Qdrant is the single vector store** (2026-07-03). Relational DB is source of record; all embeddings live in Qdrant (`garbanzo_memory`). pgvector removed. Semantic search works in SQLite deployments. `VECTOR_STORE=none` = keyword-only. Embeddings: OpenAI `text-embedding-3-small` @ 1536; deterministic is tests/offline only and never mixed into a live collection.
- **WhatsApp anti-ban is load-bearing**: Baileys 7.x + baileys-antiban, outbound safety rules in `docs/ADR-0001-whatsapp-outbound-safety.md`, warm-up limits `day1Limit`/`maxPerDay` = 2000. Never bypass the outbound-safety layer.
- **Moderation is human-in-the-loop**: the bot warns in-group and DMs the owner; only the owner acts. Never auto-ban, never let members direct moderation.
- **Git/GitHub: PRs only, the owner merges** — agents never self-merge or bypass branch protection. Commits use the GitHub noreply email (`25596491+jjhickman@users.noreply.github.com`); personal emails are blocked by the gitleaks PII rule.
- **Public-facing copy (README, website, Docker Hub) carries no AI-writing tells** (PRs #212–#214): no em-dash chains, no "X, not Y" constructions, no model-name dropping; plain register.
- **Releases**: tagged versions publish images to GHCR + Docker Hub; production runs on a Raspberry Pi 5 via Docker Compose. `MONITORING_TOKEN` gates `/metrics`, `/admin`, Prometheus scrapes, and Grafana admin password fallback; `WHATSAPP_LOGIN_TOKEN` gates only the WhatsApp login page.
- **Prompt changes are regression-tested against `tests/evals/prompt-eval-set.json`** (2026-07-03) — when changing PERSONA.md, persona.ts, or tools.ts, check the relevant eval categories before merging.
- **Cross-platform bridging (v3, 2026-07-06):** bridge relays are delivered as direct messenger sends on the receiving instance, never re-injected as synthetic inbounds — loop prevention falls out of the existing self/bot-message drop. Receiver-side idempotency inserts the dedup key before attempting delivery and deletes it if delivery throws, so a sender retry of the same envelope is treated as fresh rather than silently dropped. A WhatsApp send that comes back `WhatsAppOutboundHeldError` is backpressure, not failure — the bridge folds that message into the route's summary buffer rather than blind-retrying. Capture sits in `processInboundMessage` right after sanitization + moderation, as a fire-and-forget enqueue. Bridge code must never call `sendControlText` (the anti-ban bypass).
- **Instance identity (v3):** `INSTANCE_ID` is deployment identity for bridging, shared-fact ids, and metrics, and defaults to `MESSAGING_PLATFORM` so existing deployments need no change. Running two instances of the same platform (for example two WhatsApp numbers) is a documented compose-copy pattern (new service name, `INSTANCE_ID`, env file, volumes, port), not a wizard flow. Persona names still never name infrastructure (the v2 directive stands) — `INSTANCE_ID` is a distinct, operator-chosen category, so a deployment can be named `remy` while its compose service stays named `discord`.
- **Shared-memory privacy invariant (v3):** nothing enters the shared Qdrant collection except a fact the owner explicitly ran `!memory share <id>` on — no auto-sharing of conversation history, session summaries, or auto-extracted facts. Shared-fact ids are namespaced `<INSTANCE_ID>:<localId>` so numeric ids never collide across instances; a peer instance can retrieve a shared fact but only the origin instance can unshare it.
- **Dual bridge transport (v3):** a durable, transport-agnostic per-instance SQLite outbox (`bridge_outbox`, with dead-lettering) sits above both transports. `http` (default) is direct instance-to-instance HTTP, no extra containers, for the two-instance case; `amqp` (owner-directed, `broker` compose profile running RabbitMQ) is for three-or-more instances and durability across long peer outages. `amqplib` is an owner-approved new dependency for the amqp transport.
- **Telegram adapter (v3.3.0):** [grammY](https://grammy.dev/) is the owner-approved client library (MIT license, actively maintained) — long-polling only, webhook mode is a standing non-goal (zero inbound network config fits self-hosters). Recommended setup is privacy-mode **OFF** (`@BotFather` → `/setprivacy` → Disable) plus `requireMention: true` in `config/telegram-chats.json`: Telegram's default privacy-ON mode never delivers plain-text messages — including plain `@mentions` and this bot's `!command` convention — to the bot at all, so a privacy-ON chat is effectively reply-and-slash-command-only regardless of `requireMention`. Disabling privacy mode lets the bot see every message and then apply `requireMention` itself, the same shape as Discord's Message Content intent plus `requireMention`; privacy-ON stays a valid, degraded fallback. `TELEGRAM_CHAT_SCOPE` defaults to `configured` (not `all`, unlike `WHATSAPP_CHAT_SCOPE`) — deliberately, because anyone can add this bot to any Telegram group via its `@username`, unlike a WhatsApp number which only joins groups the operator explicitly links. The model emits the same WhatsApp-style markdown taught everywhere else (`*bold*`, `_italic_`, `~strike~`); the Telegram adapter alone translates that into MarkdownV2 at send time (`src/platforms/telegram/markdown.ts`), so no persona or prompt authors need Telegram-specific syntax. Voice transcription reuses the existing Whisper/`WHISPER_URL` path — no separate transcription config. Compose service `telegram` listens on health port `3005` (3001 WhatsApp, 3002 Discord, 3003 is a documented compose-copy example port, 3004 reserved for the Matrix service landing later in this release).

## Code Style

- **TypeScript strict mode** — no `any` types, no implicit returns
- **ES Modules** — use `import`/`export`, not `require()`
- **Zod** for all external input validation (env vars, API responses, message payloads)
- **Pino** for logging — structured JSON, never `console.log`
- **Functional composition** — prefer pure functions over classes; use classes only for stateful objects (socket, AI client)
- **Error handling** — always catch and log; never crash the process on a single message failure
- **Naming:** `camelCase` for variables/functions, `PascalCase` for types/interfaces, `SCREAMING_SNAKE` for constants
- **Files:** `kebab-case.ts`, one concern per file, max ~300 lines

### Example — Good message handler pattern:

```typescript
import { WAMessage } from '@whiskeysockets/baileys';
import { logger } from '../middleware/logger.js';

export async function handleGroupMessage(
  msg: WAMessage,
  groupId: string,
): Promise<string | null> {
  const text = msg.message?.conversation
    ?? msg.message?.extendedTextMessage?.text;

  if (!text) return null;

  // Only respond to @mentions
  if (!isMentioned(text)) return null;

  const query = stripMention(text);
  logger.info({ groupId, query }, 'Processing mention');

  // Route to AI
  const response = await getAIResponse(query, groupId);
  return response;
}
```

## Testing

- Use **Vitest** — files in `tests/` named `*.test.ts`
- Mock Baileys socket and AI clients — never make real API calls in tests
- Test message routing logic, formatting, config validation
- Run `npm test` before every commit

```bash
# Run all tests
npm test

# Run specific test
npx vitest run tests/handlers.test.ts

# Watch mode
npm run test:watch
```

## Git Workflow

- Commit messages: `type: short description` (e.g., `feat: add weather command`, `fix: handle empty message body`)
- Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`
- Branch from `main` for features
- **Before every commit:** Run `npm run check` (audit:secrets → audit:deps → typecheck → lint → test). Fix any failures before committing.
- **Before every push / PR:** Run `npm run gh:dependabot` to check for open Dependabot PRs. The CI automation guard will block PRs if Dependabot PRs are pending. Either merge them first or add the `allow-open-dependabot` label with justification.
- **After every push:** Monitor the GitHub Actions Quality Gate check. If it fails, fix the issue and push again — do not leave a PR with failing checks.

## Three-Tier Boundaries

### ✅ Always Do
- Run `npm run check` before committing (runs secrets audit → audit:deps → typecheck → lint → test). **Fix all failures before committing.**
- Run `npm run setup:hooks` after cloning to install the pre-commit PII/secret scanner
- Run `npm run gh:dependabot` before pushing or opening a PR — resolve or label open Dependabot PRs
- Run `npm run typecheck` after editing TypeScript files
- Run `npm run audit:secrets` after adding any config values, API keys, or identifiers
- Monitor CI checks after every push — fix failures immediately, never leave a PR red
- Research existing tools/libraries/APIs before implementing any new feature or utility
- Validate all environment variables with Zod at startup
- Log errors with structured context (Pino)
- Handle Baileys reconnection gracefully (check `DisconnectReason`)
- Keep the bot process alive — never let a single message crash the service
- Use `.env` for all secrets — never hardcode API keys, tokens, or phone numbers
- Save Baileys auth credentials on every `creds.update` event

### ⚠️ Ask First
- Adding new npm dependencies
- Changing the AI model routing logic
- Modifying the Baileys connection config
- Adding new WhatsApp group bindings
- Any changes to runtime JSON configs under `config/` (groups, Discord channels, bridge map, RAG sources)
- Creating new feature files in `src/features/`
- Modifying systemd service files or deployment scripts

### 🚫 Never Do
- Hardcode API keys, tokens, or phone numbers in source code
- Commit personal email addresses, phone numbers, or private contact info — use project-level channels (GitHub Issues)
- Output, embed, or commit PII (names, emails, addresses) unless the owner explicitly requests it in the current conversation
- Auto-send messages without the bot being explicitly @mentioned (except moderation alerts to owner DM)
- Commit `.env`, `baileys_auth/`, or `data/*.db` files
- Delete or modify Baileys auth state files while the bot is running
- Run `sudo` or `systemctl` commands without explicit user approval
- Add autonomous agent behaviors (scheduled messages, proactive outreach) without user sign-off
- Use `console.log` — use the Pino logger
- Import from `dist/` — always import from `src/`
- Use CommonJS (`require`) — this project uses ES Modules
