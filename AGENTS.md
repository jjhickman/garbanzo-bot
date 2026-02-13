# AGENTS.md — Garbanzo Bot

## Project Overview

**Garbanzo Bot** is a WhatsApp community bot for a 120+ member Boston-area meetup group. It uses the Baileys library (unofficial WhatsApp Web API) to connect to WhatsApp, and routes messages to AI models (Claude via Anthropic/OpenRouter, local Ollama) for intelligent responses.

The bot's persona is **Garbanzo Bean** 🫘 — a warm, direct, Boston-savvy community connector.

## Stack

- **Runtime:** Node.js 20+ with TypeScript (ES Modules)
- **WhatsApp:** `@whiskeysockets/baileys` v6 (multi-device, socket-based)
- **AI:** Anthropic Claude API (primary), Ollama (local fallback on Terra)
- **Validation:** Zod for runtime type checking
- **Logging:** Pino
- **Testing:** Vitest
- **Build:** `tsc` → `dist/`, dev via `tsx watch`

## Commands

```bash
# Install dependencies
npm install

# Development (hot-reload)
npm run dev

# Type-check without emitting
npm run typecheck

# Run linter
npm run lint

# Run tests
npm run test

# Build for production
npm run build

# Start production
npm run start

# Full pre-commit check
npm run check
```

## Project Structure

```
garbanzo-bot/
├── src/
│   ├── index.ts              # Entry point — starts bot
│   ├── bot/
│   │   ├── connection.ts     # Baileys socket setup, auth, reconnect
│   │   ├── handlers.ts       # Message routing (mention? DM? group notification?)
│   │   └── groups.ts         # Group config, JID mapping, mention patterns
│   ├── ai/
│   │   ├── router.ts         # Model selection (Claude vs Ollama vs skip)
│   │   ├── claude.ts         # Anthropic/OpenRouter API client
│   │   ├── ollama.ts         # Local Ollama client
│   │   └── persona.ts        # System prompt builder (loads PERSONA.md)
│   ├── features/             # Each feature = one file, added incrementally
│   │   ├── weather.ts        # Google Weather API
│   │   ├── transit.ts        # MBTA schedule/alerts
│   │   ├── moderation.ts     # Content moderation (human-in-the-loop)
│   │   └── ...               # Future: events, news, dnd, etc.
│   ├── middleware/
│   │   ├── rate-limit.ts     # Per-user/per-group rate limiting
│   │   └── logger.ts         # Structured logging middleware
│   └── utils/
│       ├── config.ts         # Env var loading + Zod validation
│       ├── formatting.ts     # WhatsApp text formatting helpers
│       └── jid.ts            # JID parsing/comparison utilities
├── config/
│   └── groups.json           # Group ID → name mapping + per-group settings
├── docs/
│   ├── PERSONA.md            # Garbanzo Bean character doc (loaded at runtime)
│   ├── SECURITY.md           # Security audit findings + recommendations
│   ├── ROADMAP.md            # Phased implementation plan
│   └── INFRASTRUCTURE.md     # Hardware/network reference
├── data/                     # Runtime data (gitignored DBs, persisted state)
├── scripts/
│   └── setup.sh              # First-time setup helper
├── tests/
│   └── *.test.ts             # Vitest test files
├── baileys_auth/             # Baileys auth state (gitignored)
├── .env                      # Secrets (gitignored)
├── .env.example              # Template for .env
├── opencode.json             # OpenCode AI agent config
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
- Run `npm run typecheck` after editing TypeScript files
- Validate all environment variables with Zod at startup
- Log errors with structured context (Pino)
- Handle Baileys reconnection gracefully (check `DisconnectReason`)
- Keep the bot process alive — never let a single message crash the service
- Use `.env` for all secrets — never hardcode API keys
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
