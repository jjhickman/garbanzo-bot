# AGENTS.md — Garbanzo

## Project Overview

**Garbanzo** is a multi-platform community bot serving a 120+ member Boston-area meetup group. WhatsApp (via the Baileys unofficial WhatsApp Web API) is the production platform; Discord, Slack, and Teams adapters exist behind a shared platform abstraction (`src/core/` + `src/platforms/`). Messages route to AI models via a configurable cloud failover order (`AI_PROVIDER_ORDER`) plus local Ollama for simple queries.

The bot's persona is **Garbanzo Bean** 🫘 — a warm, direct, Boston-savvy community connector.

## Stack

- **Runtime:** Node.js 20+ with TypeScript (ES Modules)
- **WhatsApp:** `@whiskeysockets/baileys` v6 (multi-device, socket-based)
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

```
garbanzo-bot/
├── src/
│   ├── index.ts              # Entry point — selects platform runtime, starts bot
│   ├── core/                 # Platform-agnostic message pipeline
│   │   ├── messaging-platform.ts / messaging-adapter.ts / platform-messenger.ts
│   │   │                     # Platform abstraction: adapter contract + outbound messenger
│   │   ├── inbound-message.ts / process-inbound-message.ts / process-group-message.ts
│   │   │                     # Normalized inbound shape + shared processing pipeline
│   │   ├── response-router.ts # Bang commands + natural-language feature routing
│   │   ├── groups-config.ts  # Group config, JID mapping, per-group personas
│   │   └── vision.ts, poll-payload.ts, message-ref.ts
│   ├── platforms/            # One directory per platform, each with adapter + runtime
│   │   ├── whatsapp/         # PRODUCTION. Baileys socket, anti-ban outbound safety,
│   │   │                     #   owner commands, login server/store, digest, recaps,
│   │   │                     #   event reminders, media, mentions, reactions
│   │   ├── discord/          # Gateway runtime + demo server
│   │   ├── slack/            # Events server, token manager, demo servers
│   │   └── teams/            # Runtime stub
│   ├── ai/
│   │   ├── router.ts         # Model selection (cloud vs Ollama) + cost tracking
│   │   ├── cloud-providers.ts / cloud-call.ts # Shared request builders/parsers per provider API
│   │   ├── claude.ts, chatgpt.ts, gemini.ts, bedrock.ts, ollama.ts # Provider callers
│   │   ├── openai-oauth.ts   # OpenAI PKCE OAuth flow
│   │   ├── persona.ts        # System prompt builder (loads docs/PERSONA.md + docs/personas/<platform>.md)
│   │   ├── tools.ts          # AI tool definitions (weather, transit, venues, news, books, web_search, memory)
│   │   └── tool-loop.ts      # Provider-agnostic tool-calling loop
│   ├── features/             # Each feature = one file (or directory), max ~300 lines
│   │                         # weather, transit, venues, news, books, web-search, events,
│   │                         # moderation, introductions, memory(+extract), polls, profiles,
│   │                         # recap, digest, dnd, character/, voice, language, fun, help, …
│   ├── middleware/
│   │   ├── rate-limit.ts     # Per-user/per-group rate limiting
│   │   ├── logger.ts         # Structured logging (Pino)
│   │   ├── context.ts        # Two-tier context compression + caching
│   │   ├── stats.ts          # Token estimation, cost tracking, tool-call counters
│   │   ├── health.ts         # HTTP health/metrics endpoints + memory watchdog
│   │   ├── admin-page.ts     # Token-gated owner admin page (/admin)
│   │   ├── retry.ts          # Dead letter retry queue
│   │   └── sanitize.ts       # Input sanitization + prompt injection detection
│   └── utils/
│       ├── config.ts         # Env var loading + Zod validation
│       ├── db.ts             # DB barrel; db-backend.ts selects SQLite (default) or Postgres
│       ├── db-sqlite.ts, db-postgres.ts, db-schema.ts, db-profiles.ts, db-maintenance.ts, …
│       ├── embedding-provider.ts, text-embedding.ts, reranker.ts, eval-retrieval.ts
│       │                     # Retrieval/vector-memory groundwork (see docs/VECTOR_DB_PLAN.md)
│       ├── session-summary.ts, session-backfill.ts
│       └── formatting.ts, jid.ts
├── config/groups.json        # Group ID → name mapping + per-group settings
├── docs/                     # PERSONA.md (runtime prompt), personas/<platform>.md overrides,
│                             # ARCHITECTURE, SECURITY, MONITORING, PLATFORMS, RELEASES,
│                             # ADR-0001 (outbound safety), POSTGRES_MIGRATION_RUNBOOK, …
├── monitoring/               # Self-hosted Prometheus + Grafana stack
├── infra/                    # Deployment infrastructure
├── website/                  # garbanzobot.com static site
├── data/                     # Runtime data (gitignored DBs, persisted state)
├── scripts/                  # setup wizard, gh account helpers, secret rotation/audit
├── tests/                    # Vitest, 66 test files / 700+ tests
│   └── evals/                # Prompt-behavior eval set (see tests/evals/README.md)
├── Dockerfile                # Multi-stage build (node:22-alpine, dumb-init)
├── docker-compose*.yml       # dev / prod / aws variants
├── baileys_auth/             # Baileys auth state (gitignored)
├── .env / .env.example       # Secrets (gitignored) / template
├── .gitleaks.toml            # Secret + PII scanning config
└── AGENTS.md                 # This file
```

## Decisions Log

Settled questions — **do not relitigate these**; propose a change only with new evidence, and note it here when a decision changes.

- **OpenAI is the primary AI provider** (owner decision, 2026-06). Anthropic/Gemini/Bedrock/Ollama are failover via `AI_PROVIDER_ORDER`. When an integration misbehaves, fix the integration — do not propose switching primary provider.
- **Production models: `gpt-5.4-mini` primary, `claude-haiku-4-5` fallback, prompt caching on** (2026-07-01).
- **One deployment = one platform** (`MESSAGING_PLATFORM`). WhatsApp is production; Discord/Slack are demo-grade; Teams is a stub. Multi-tenant single-deployment was not chosen.
- **Web search is multi-provider with priority Firecrawl → Brave → Google PSE → SearXNG** (PRs #216, #220). `web_search` tool results get a 6,000-char budget vs 1,500 for other tools, to allow extracted page content.
- **The system prompt must explicitly direct models to prefer tools over training data** (PR #218) — without it, models answer factual questions from stale memory. Preserve this directive in any prompt rewrite.
- **Storage: SQLite is the default backend**; Postgres exists behind `db-backend.ts` (runbook: `docs/POSTGRES_MIGRATION_RUNBOOK.md`). Vector memory is planned, not enabled (`docs/VECTOR_MEMORY_IMPLEMENTATION_SPEC.md`).
- **WhatsApp anti-ban is load-bearing**: Baileys 7.x + baileys-antiban, outbound safety rules in `docs/ADR-0001-whatsapp-outbound-safety.md`, warm-up limits `day1Limit`/`maxPerDay` = 2000. Never bypass the outbound-safety layer.
- **Moderation is human-in-the-loop**: the bot warns in-group and DMs the owner; only the owner acts. Never auto-ban, never let members direct moderation.
- **Git/GitHub: PRs only, the owner merges** — agents never self-merge or bypass branch protection. Commits use the GitHub noreply email (`25596491+jjhickman@users.noreply.github.com`); personal emails are blocked by the gitleaks PII rule.
- **Public-facing copy (README, website, Docker Hub) carries no AI-writing tells** (PRs #212–#214): no em-dash chains, no "X, not Y" constructions, no model-name dropping; plain register.
- **Releases**: tagged versions publish images to GHCR + Docker Hub; production runs on a Raspberry Pi 5 via Docker Compose. Grafana admin password intentionally defaults to `WHATSAPP_LOGIN_TOKEN` (PR #209).
- **Prompt changes are regression-tested against `tests/evals/prompt-eval-set.json`** (2026-07-03) — when changing PERSONA.md, persona.ts, or tools.ts, check the relevant eval categories before merging.

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
- Any changes to `config/groups.json`
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
