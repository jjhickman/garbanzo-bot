# AGENTS.md — Garbanzo

## Project Overview

**Garbanzo** is a WhatsApp community bot for a 120+ member Boston-area meetup group. It uses the Baileys library (unofficial WhatsApp Web API) to connect to WhatsApp, and routes messages to AI models (configurable cloud failover order + local Ollama) for intelligent responses.

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

1. **Pre-commit hook** — `gitleaks protect --staged` runs automatically on every `git commit`. Blocks commits containing API keys, tokens, private keys, or other secrets.
2. **`npm run check`** — The full pre-commit check pipeline (`audit:secrets` → `typecheck` → `lint` → `test`) includes a gitleaks scan of the working directory. Run this before every commit.
3. **`npm run audit:secrets`** — Standalone secret scan. Use `--verbose` for detailed findings, `--staged` for only staged files.

**Configuration:** `.gitleaks.toml` at project root. Built-in rules detect 150+ secret types. Custom rules added for WhatsApp JIDs. Allowlists configured for files that legitimately reference patterns (docs, examples, config).

**If gitleaks flags a finding:**
- Move the secret to `.env` (gitignored)
- Reference via `process.env.VAR_NAME` in code
- For test files, use fake values (`test_key_xxx`, `5550001234`)
- For genuine false positives, add an inline `gitleaks:allow` comment or update `.gitleaks.toml` allowlist

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

# Build for production
npm run build

# Start production
npm run start

# Full pre-commit check (secrets + typecheck + lint + test)
npm run check
```

## Project Structure

```
garbanzo-bot/
├── src/
│   ├── index.ts              # Entry point — starts bot
│   ├── bot/
│   │   ├── connection.ts     # Baileys socket setup, auth, reconnect
│   │   ├── handlers.ts       # Top-level message dispatcher
│   │   ├── group-handler.ts  # Group message routing + mention handling
│   │   ├── owner-commands.ts # Owner DM command routing
│   │   ├── response-router.ts # Bang commands + natural language feature routing
│   │   ├── reactions.ts      # Emoji reactions (🫘 for acknowledgments)
│   │   └── groups.ts         # Group config, JID mapping, mention patterns
│   ├── ai/
│   │   ├── router.ts         # Model selection (cloud vs Ollama) + cost tracking
│   │   ├── claude.ts         # Claude-family caller (OpenRouter/Anthropic)
│   │   ├── chatgpt.ts        # OpenAI fallback caller
│   │   ├── cloud-providers.ts # Shared cloud request builders/parsers
│   │   ├── ollama.ts         # Local Ollama client
│   │   └── persona.ts        # System prompt builder (loads PERSONA.md)
│   ├── features/             # Each feature = one file (or directory), max ~300 lines
│   │   ├── character/        # D&D 5e character sheet generator (6 files)
│   │   ├── weather.ts        # Google Weather API
│   │   ├── transit.ts        # MBTA schedule/alerts
│   │   ├── transit-data.ts   # Station/route aliases, emoji maps, types
│   │   ├── moderation.ts     # Content moderation (human-in-the-loop)
│   │   ├── moderation-patterns.ts # Regex rules, category maps, thresholds
│   │   ├── introductions.ts  # Auto-respond to new member intros
│   │   ├── intro-classifier.ts # Signal-based intro detection logic
│   │   ├── dnd.ts            # D&D dice roller + command handler
│   │   ├── dnd-lookups.ts    # SRD API lookups (spell, monster, class, item)
│   │   └── ...               # events, news, books, venues, polls, fun, etc.
│   ├── middleware/
│   │   ├── rate-limit.ts     # Per-user/per-group rate limiting
│   │   ├── logger.ts         # Structured logging (Pino)
│   │   ├── context.ts        # Two-tier context compression + caching
│   │   ├── stats.ts          # Token estimation, daily cost tracking
│   │   ├── health.ts         # HTTP health endpoint + memory watchdog
│   │   ├── retry.ts          # Dead letter retry queue
│   │   └── sanitize.ts       # Input sanitization + prompt injection detection
│   └── utils/
│       ├── config.ts         # Env var loading + Zod validation
│       ├── formatting.ts     # WhatsApp text formatting helpers
│       ├── jid.ts            # JID parsing/comparison utilities
│       ├── db.ts             # SQLite barrel (re-exports schema, profiles, maintenance)
│       ├── db-schema.ts      # Database init, table definitions
│       ├── db-profiles.ts    # Member profile queries
│       └── db-maintenance.ts # Backup, vacuum, prune, scheduled maintenance
├── config/
│   └── groups.json           # Group ID → name mapping + per-group settings
├── docs/
│   ├── PERSONA.md            # Garbanzo Bean character doc (loaded at runtime)
│   ├── SECURITY.md           # Security audit findings + recommendations
│   ├── ROADMAP.md            # Phased implementation plan
│   ├── ARCHITECTURE.md       # Data flow, routing, multimedia pipeline docs
│   ├── INFRASTRUCTURE.md     # Hardware/network reference
│   └── SETUP_EXAMPLES.md     # Reusable setup command recipes
├── data/                     # Runtime data (gitignored DBs, persisted state)
├── scripts/
│   ├── setup.mjs             # Interactive setup wizard
│   └── setup.sh              # Wrapper for setup wizard
├── tests/
│   └── *.test.ts             # Vitest test files (11 files, 440 tests)
├── Dockerfile                # Multi-stage build (node:22-alpine, dumb-init)
├── docker-compose.yml        # Named volumes, env_file, health check
├── .dockerignore             # Excludes .git, node_modules, tests, etc.
├── baileys_auth/             # Baileys auth state (gitignored)
├── .env                      # Secrets (gitignored)
├── .env.example              # Template for .env
├── .gitleaks.toml            # Secret scanning config (gitleaks)
├── opencode.json             # OpenCode AI agent config (gitignored — has secrets)
├── opencode.json.example     # Template for opencode.json
├── package.json
├── tsconfig.json
└── AGENTS.md                 # This file
```

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
- Run `npm run check` before committing

## Three-Tier Boundaries

### ✅ Always Do
- Run `npm run check` before committing (runs secrets audit → typecheck → lint → test)
- Run `npm run typecheck` after editing TypeScript files
- Run `npm run audit:secrets` after adding any config values, API keys, or identifiers
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
- Auto-send messages without the bot being explicitly @mentioned (except moderation alerts to owner DM)
- Commit `.env`, `baileys_auth/`, or `data/*.db` files
- Delete or modify Baileys auth state files while the bot is running
- Run `sudo` or `systemctl` commands without explicit user approval
- Add autonomous agent behaviors (scheduled messages, proactive outreach) without user sign-off
- Use `console.log` — use the Pino logger
- Import from `dist/` — always import from `src/`
- Use CommonJS (`require`) — this project uses ES Modules
