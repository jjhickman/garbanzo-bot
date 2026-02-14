# Garbanzo Bot

A WhatsApp community bot built with [Baileys](https://github.com/WhiskeySockets/Baileys) and Claude AI. Originally built for a 120+ member Boston-area meetup group, designed to be adaptable to any community or locale.

## What It Does

Garbanzo connects to WhatsApp via the multi-device Web API, listens for @mentions in group chats, and responds with AI-powered answers, real-time data lookups, and community management tools. It runs as a single Node.js process with SQLite storage — no external databases, no containers, no cloud infrastructure required.

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/jhickmanit/garbanzo-bot.git
cd garbanzo-bot
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys (see Configuration below)

# 3. Configure your groups
# Edit config/groups.json with your WhatsApp group IDs

# 4. Start in development mode
npm run dev

# 5. Scan the QR code with WhatsApp when prompted
```

On first run, Baileys will display a QR code in the terminal. Scan it with WhatsApp (Settings > Linked Devices) to authenticate. Auth state persists in `baileys_auth/` across restarts.

## Features

### AI Chat
- Responds to `@garbanzo` mentions with Claude AI (Anthropic/OpenRouter)
- Local Ollama fallback for simple queries (reduces API costs by routing to qwen3:8b)
- Conversation context from SQLite — remembers recent messages per group
- Multi-language detection (11 languages) — responds in the user's language
- Custom per-group persona — different tone per group (casual in General, structured in Events)
- Context compression — recent messages verbatim, older messages extractively compressed

### Community
- **Introductions** — AI-powered personal welcomes for new member introductions (no @mention needed)
- **Welcome messages** — greets new participants when they join a group
- **Events** — detects event proposals, enriches with weather/transit/AI logistics
- **Polls** — native WhatsApp polls: `!poll Question? / A / B / C`
- **Profiles** — opt-in interest tracking: `!profile interests hiking, cooking`
- **Recommendations** — `!recommend` suggests events based on your interests
- **Summaries** — `!summary` / `!catchup` for "what did I miss?" recaps
- **Feedback** — `!suggest`, `!bug`, `!upvote` for community-driven improvements
- **Daily digest** — owner-only summary of daily bot activity

### Information
- **Weather** — `!weather` / `!forecast` via Google Weather API (default: Boston)
- **MBTA Transit** — `!transit` / `!mbta` for real-time alerts, predictions, schedules
- **News** — `!news [topic]` via NewsAPI
- **Venues** — `!venue bars in somerville` via Google Places API
- **Books** — `!book [title]` via Open Library API

### D&D 5e
- **Dice** — `!roll 2d6+3`, `!roll d20`
- **Lookups** — `!dnd spell fireball`, `!dnd monster goblin`
- **Character sheets** — `!character elf wizard` generates a filled PDF (official WotC template, levels 1-20)

### Fun
- `!trivia` — random or category-specific trivia
- `!fact` — random fun fact
- `!today` — this day in history
- `!icebreaker` — conversation starters (40 curated, Boston-themed)

### Moderation & Safety
- Content moderation: regex patterns + OpenAI Moderation API (human-in-the-loop)
- Strike tracking with soft-mute after threshold
- Input sanitization: control chars, message length, prompt injection detection
- All flags sent to owner DM — bot never auto-acts on content

### Owner Commands (DM only)
- `!memory add/delete/search` — manage long-term community facts injected into AI context
- `!feedback` — review pending suggestions and bug reports
- `!release <notes>` — broadcast release notes to all groups
- `!strikes` — view moderation strike counts
- `!digest` — preview daily activity summary
- `!catchup intros` — recent introduction summaries

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` | Yes | AI responses (Claude) |
| `GOOGLE_API_KEY` | No | Weather + venue search |
| `MBTA_API_KEY` | No | Transit data (Boston-specific) |
| `NEWSAPI_KEY` | No | News search |
| `OPENAI_API_KEY` | No | Content moderation |
| `OLLAMA_BASE_URL` | No | Local model inference (default: `http://127.0.0.1:11434`) |
| `OWNER_JID` | Yes | Owner WhatsApp JID for admin features |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) |

Features degrade gracefully when API keys are missing — the bot won't crash, it just skips that feature.

### Group Configuration

Edit `config/groups.json` to map your WhatsApp group IDs:

```json
{
  "groups": {
    "YOUR_GROUP_JID@g.us": {
      "name": "General",
      "enabled": true,
      "requireMention": true,
      "persona": "Casual and conversational.",
      "enabledFeatures": ["weather", "transit", "fun"]
    }
  },
  "mentionPatterns": ["@yourbot", "@YourBot"],
  "admins": {
    "owner": {
      "name": "Your Name",
      "jid": "1YOURNUMBER@s.whatsapp.net"
    }
  }
}
```

To find your group JIDs, enable `LOG_LEVEL=debug` and check logs when messages arrive.

**Per-group options:**
- `enabled` — whether the bot responds in this group
- `requireMention` — if true, bot only responds to @mentions (recommended)
- `persona` — custom personality hint for this group (injected into Claude prompt)
- `enabledFeatures` — array of feature names to enable (omit for all features)

## Adapting for Your Community

Garbanzo was built for Boston, but the architecture is locale-agnostic. Here's what to customize:

### 1. Persona (`docs/PERSONA.md`)
This file defines the bot's personality and is loaded at runtime into every AI prompt. Replace Boston references with your city, update the voice/tone, and adjust the "community knowledge" section.

### 2. Transit (`src/features/transit.ts`)
Currently uses the MBTA API. To adapt:
- Replace the API client with your city's transit API
- Update station/route aliases in the lookup maps
- Adjust the response formatting

### 3. Weather (`src/features/weather.ts`)
Default location is Boston. Change the `DEFAULT_LOCATION` constant to your city.

### 4. Groups (`config/groups.json`)
Replace all group JIDs and names with your own. Persona hints are per-group.

### 5. Mention Patterns (`config/groups.json`)
Update `mentionPatterns` to match your bot's name as it appears in WhatsApp.

### 6. Icebreakers (`src/features/fun.ts`)
The curated icebreaker list is Boston-themed. Replace with your city's landmarks, neighborhoods, and culture.

### 7. Memory Facts (`!memory add`)
After deploying, use `!memory add` to teach the bot about your community's venues, traditions, and members.

## Architecture

```
src/
  index.ts              # Entry point — starts bot, wires services
  bot/
    connection.ts       # Baileys socket, auth, reconnect, staleness detection
    handlers.ts         # Message routing, sanitization, feature dispatch
    groups.ts           # Group config, feature flags, per-group persona
  ai/
    router.ts           # Model selection (Claude vs Ollama) + cost tracking
    claude.ts           # Anthropic/OpenRouter client
    ollama.ts           # Local Ollama client + warm-up scheduler
    persona.ts          # System prompt builder (PERSONA.md + memory + language + persona hints)
  features/             # One file per feature
    weather.ts, transit.ts, news.ts, events.ts, moderation.ts,
    welcome.ts, introductions.ts, dnd.ts, character.ts, books.ts,
    venues.ts, polls.ts, fun.ts, feedback.ts, profiles.ts,
    summary.ts, recommendations.ts, language.ts, memory.ts,
    release.ts, help.ts, router.ts, digest.ts
  middleware/
    rate-limit.ts       # Per-user/per-group sliding window
    logger.ts           # Pino structured logging
    context.ts          # Two-tier context compression + caching
    stats.ts            # Token estimation, daily cost tracking
    health.ts           # HTTP health endpoint + memory watchdog
    retry.ts            # Dead letter retry queue
    sanitize.ts         # Input sanitization + prompt injection detection
  utils/
    config.ts           # Zod-validated env vars
    formatting.ts       # WhatsApp text formatting
    jid.ts              # JID parsing/comparison
    db.ts               # SQLite schema (6 tables), maintenance, backups
config/groups.json      # Per-group settings
docs/                   # Persona, roadmap, security, infrastructure
tests/                  # Vitest (392 tests)
```

## Stack

- **Runtime:** Node.js 20+ / TypeScript (ES Modules, strict mode)
- **WhatsApp:** @whiskeysockets/baileys v6 (multi-device)
- **AI:** Claude via Anthropic/OpenRouter (primary), Ollama qwen3:8b (local fallback)
- **Storage:** SQLite via better-sqlite3 (WAL mode, auto-vacuum, nightly backups)
- **Validation:** Zod
- **Logging:** Pino (structured JSON)
- **Testing:** Vitest (392 tests)
- **PDF:** pdf-lib (D&D character sheets)

## Development

```bash
npm run dev         # Hot-reload (tsx watch)
npm run typecheck   # Type-check only
npm run test        # Run all tests
npm run lint        # ESLint
npm run check       # Full pre-commit: typecheck + lint + test
npm run build       # Compile to dist/
npm run start       # Production (from dist/)
```

## Production Deployment

The bot runs as a systemd user service:

```bash
# Build
npm run build

# Install service (adjust paths in scripts/garbanzo-bot.service)
cp scripts/garbanzo-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable garbanzo-bot
systemctl --user start garbanzo-bot

# Check status
systemctl --user status garbanzo-bot
curl http://127.0.0.1:3001/health
```

The health endpoint returns JSON with connection status, uptime, memory usage, and message staleness.

## Docs

- [PERSONA.md](docs/PERSONA.md) — Bot personality and voice guidelines
- [ROADMAP.md](docs/ROADMAP.md) — Phased implementation plan (Phases 1-6 complete)
- [SECURITY.md](docs/SECURITY.md) — Infrastructure security audit + data privacy
- [INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md) — Hardware and network reference
- [CHANGELOG.md](CHANGELOG.md) — Full release history
- [CONTRIBUTING.md](CONTRIBUTING.md) — How to contribute
- [AGENTS.md](AGENTS.md) — Coding agent instructions and conventions

## License

[MIT](LICENSE) — Josh Hickman
