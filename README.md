# Garbanzo
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo

![Garbanzo Logo](docs/assets/garbanzo-logo.svg)

[![Quality Gate](https://github.com/jjhickman/garbanzo-bot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jjhickman/garbanzo-bot/actions/workflows/ci.yml)
[![Docker Hub](https://img.shields.io/docker/v/jjhickman/garbanzo?label=dockerhub)](https://hub.docker.com/r/jjhickman/garbanzo)
[![Docker Pulls](https://img.shields.io/docker/pulls/jjhickman/garbanzo)](https://hub.docker.com/r/jjhickman/garbanzo)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Garbanzo is an AI chat operations platform for communities and small teams. It combines multi-provider LLM routing, practical automations, and Docker-first deployment so you can run useful AI workflows directly in group chat.

## Highlights
- Multi-provider LLM routing with Claude, OpenAI, Gemini, Bedrock, OpenRouter, failover, and optional local Ollama for low-cost/simple traffic.
- Community workflows for introductions, summaries, events, polls, recommendations, feedback, memory, and owner digests.
- Practical integrations for weather, MBTA transit, news, venues, books, D&D dice/lookups, and character sheet PDFs.
- WhatsApp-first runtime with browser login, plus Slack and Discord scaffolds with demo modes.
- Operational guardrails: health/readiness endpoints, backups, retry queue, moderation review, rate limits, and per-group feature allowlists.
- Docker-first deployment with SQLite by default and Postgres support for semantic session retrieval.

## See it in action
A few real screenshots from Garbanzo in WhatsApp (real outputs, not mockups).

### Help + command discovery
In a busy group chat, "help" should be fast, readable, and copy/pasteable.
<p align="center">
  <img src="docs/assets/screenshots/real/help-usage.jpg" width="420" alt="Help + command discovery" />
</p>

### Introductions welcome
Introductions are the one place Garbanzo replies without needing an @mention.
<p align="center">
  <img src="docs/assets/screenshots/real/introductions-welcome.jpg" width="420" alt="Introductions welcome" />
</p>

### Weather report
Quick, local weather for planning (default city is configurable).
<p align="center">
  <img src="docs/assets/screenshots/real/weather-report.jpg" width="420" alt="Weather report" />
</p>

### MBTA alerts
Transit alerts + delays when the group is trying to meet up.
<p align="center">
  <img src="docs/assets/screenshots/real/mbta-alerts.jpg" width="420" alt="MBTA alerts" />
</p>

### Restaurant recommendations
Local recommendations tuned to Boston-area neighborhoods.
<p align="center">
  <img src="docs/assets/screenshots/real/restaurant-recommendations.jpg" width="420" alt="Restaurant recommendations" />
</p>

### Local news
Quick headlines and links when someone asks what's happening in the city.
<p align="center">
  <img src="docs/assets/screenshots/real/news.jpg" width="420" alt="Local news" />
</p>

### Book recommendations
A lightweight example of "community concierge" behavior beyond Q&A.
<p align="center">
  <img src="docs/assets/screenshots/real/book-recommendations.jpg" width="420" alt="Book recommendations" />
</p>

### D&D character sheet generator
Structured output + a real PDF attachment for tabletop groups.
<p align="center">
  <img src="docs/assets/screenshots/real/dnd-character.jpg" width="420" alt="D&D character sheet generator" />
</p>

## Quick Start
Requirements: Docker + Docker Compose for the default deployment; Node.js 20+ only for the setup wizard and local development.

```bash
# 1. Clone
git clone https://github.com/jjhickman/garbanzo-bot.git
cd garbanzo-bot

# 2. Run interactive setup (messaging platform, provider order, models, feature profile, optional PERSONA.md import, groups)
npm run setup

# 3. Start default deployment (Docker Compose)
docker compose up -d

# Optional: pull official Docker Hub image directly
# docker pull jjhickman/garbanzo:1.0.0

# 4. Watch logs (and complete platform auth/linking if prompted)
docker compose logs -f garbanzo

# 5. Health check
curl http://127.0.0.1:3001/health

# 6. First AI response test (in chat)
# @garbanzo !summary
# @garbanzo plan dinner in somerville this friday
```

If you want the fastest non-chat test path first, run Slack demo mode and post a demo payload to `http://127.0.0.1:3002/demo/chat`.

## Table of Contents
[Features](#features) · [Configuration](#configuration) · [Platforms & Login](#platforms--login) · [AI Providers & Routing](#ai-providers--routing) · [Deployment](#deployment) · [Customizing for Your Community](#customizing-for-your-community) · [Architecture & Stack](#architecture--stack) · [Development](#development) · [Docs](#docs) · [Contributing - Support - License](#contributing---support---license)

## Features
### AI Chat Capabilities
- Responds to `@garbanzo` mentions with configurable cloud AI failover order (`AI_PROVIDER_ORDER`)
- Local Ollama fallback for simple queries (reduces API costs by routing to qwen3:8b)
- Conversation context from SQLite or Postgres — remembers recent messages per group
- **Session memory** — conversations are sessionized by inactivity gap, extractively summarized, and stored with vector embeddings for long-horizon recall (e.g., "what did we decide about trivia last week?")
- **Semantic retrieval** — session summaries and message hits are merged and reranked with a unified scoring model (recency decay, token overlap, coverage deduplication) before injection into the AI prompt
- **Embedding provider routing** — deterministic hash embeddings by default, OpenAI `text-embedding-3-small` available with automatic fallback
- Multi-language detection (14 languages) — responds in the user's language
- Custom per-group persona — different tone per group (casual in General, structured in Events)
- Context compression — recent messages verbatim, older messages extractively compressed, session summaries for long-range context
### Community Workflows
- **Introductions** — AI-powered personal welcomes for new member introductions (no @mention needed)
- **Welcome messages** — greets new participants when they join a group
- **Events** — detects event proposals, enriches with weather/transit/AI logistics
- **Polls** — native WhatsApp polls: `!poll Question? / A / B / C`
- **Profiles** — opt-in interest tracking: `!profile interests hiking, cooking`
- **Recommendations** — `!recommend` suggests events based on your interests
- **Summaries** — `!summary` / `!catchup` for "what did I miss?" recaps
- **Feedback** — `!suggest`, `!bug`, `!upvote` for community-driven improvements
- **Daily digest** — owner-only summary of daily bot activity
### External Integrations
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
- `!release rules` — show member-facing release update rules
- `!release preview <notes>` — lint + preview release notes without sending
- `!release send <notes>` — broadcast release notes to all enabled groups
- `!release send <group> <notes>` — broadcast release notes to one group
- `!release send changelog [lines]` — broadcast latest changelog snippet
- `!release internal <notes>` — keep update operator-only (no broadcast)
- `!strikes` — view moderation strike counts
- `!digest` — preview daily activity summary
- `!catchup intros` — recent introduction summaries

## Configuration
Copy `.env.example` to `.env`, then set provider credentials, owner identity, health bind options, and optional integration keys. Group names, per-group personas, mention patterns, and feature allowlists live in `config/groups.json`.
Features degrade gracefully when API keys are missing — the bot won't crash, it just skips that feature.
Full reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

<a id="platforms--login"></a>

## Platforms & Login
WhatsApp is the default runtime and links through a token-gated browser page on the health server. Slack and Discord have official runtime scaffolds plus local demo modes for pipeline verification without a full app setup.
Setup details: [docs/PLATFORMS.md](docs/PLATFORMS.md)

<a id="ai-providers--routing"></a>

## AI Providers & Routing
- **Multi-provider cloud failover:** route across Claude, OpenAI, Gemini, Bedrock, and OpenRouter with configurable priority (`AI_PROVIDER_ORDER`)
- **Hybrid cloud + local mode:** use Ollama for low-cost/simple requests while reserving cloud models for high-complexity prompts
- **Per-provider model control:** set explicit model overrides (`ANTHROPIC_MODEL`, `OPENAI_MODEL`, `GEMINI_MODEL`, `OPENROUTER_MODEL`, `BEDROCK_MODEL_ID`)
- **Cost-aware operations:** token and pricing fields support practical cost tracking and routing decisions

| Provider | Primary Strength | Typical Role in Routing |
|----------|------------------|-------------------------|
| Anthropic Claude | nuanced reasoning, long-form quality | quality-first primary or complex fallback |
| OpenAI | broad capability and tool reliability | balanced primary or secondary |
| Gemini | speed and cost efficiency | fast primary for high-volume traffic |
| OpenRouter | model marketplace flexibility | portability/fallback layer |
| AWS Bedrock | managed AWS inference + IAM-native auth | cloud provider in failover order |
| Ollama (local) | privacy + near-zero marginal cost | simple-query local path |
OpenAI supports `OPENAI_AUTH_MODE=apikey` by default. Experimental `OPENAI_AUTH_MODE=oauth` can sign in with ChatGPT and store tokens in `data/openai-oauth.json`.
> Warning: OAuth mode is unofficial, uses a private ChatGPT backend, can break without notice, and should never be your only provider.
Headless/manual auth and Docker token injection: [docs/CONFIGURATION.md#openai-oauth-experimental](docs/CONFIGURATION.md#openai-oauth-experimental)

## Deployment
Default Docker Compose deployment:

```bash
docker compose up -d
docker compose logs -f garbanzo
curl http://127.0.0.1:3001/health
```

Pinned production pull:

```bash
APP_VERSION=0.2.2 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull garbanzo
APP_VERSION=0.2.2 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Local development build:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Cross-platform portable binaries are published on version tags (`v*`) as release assets. Alternative: systemd user service for native Node deployment (`scripts/garbanzo.service`).
This is what Garbanzo looks like on a basic Kuma HTTP monitor (tracking `/health`):
<p align="center">
  <img src="docs/assets/screenshots/real/kuma-dashboard.png" width="900" alt="Uptime Kuma dashboard monitoring Garbanzo health endpoint" />
</p>
The health endpoint returns JSON with connection status, uptime, memory usage, message staleness, and backup integrity status. Use `/health/ready` for alerting on disconnected or stale chat state. Deep Kuma settings and LAN firewall examples: [docs/INFRASTRUCTURE.md#monitoring--lan-firewall](docs/INFRASTRUCTURE.md#monitoring--lan-firewall)

Nightly off-machine backups of the WhatsApp credentials + database (systemd timer, verification, retention, one-command restore): [docs/BACKUPS.md](docs/BACKUPS.md)

Full observability stack — a pre-provisioned Grafana dashboard (community activity, AI cost by provider, tool usage, anti-ban trends, backups) over Prometheus, running beside the bot with `docker compose --profile monitoring up -d`: [docs/MONITORING.md](docs/MONITORING.md)

## Customizing for Your Community
Garbanzo was built for Boston, but the architecture is locale-agnostic. Customize the persona, transit provider, weather defaults, groups, mention patterns, icebreakers, and memory facts.
Guide: [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md)

<a id="architecture--stack"></a>

## Architecture & Stack
Garbanzo separates a platform-agnostic core pipeline from runtime adapters under `src/platforms/*`. It runs on Node.js 20+ and TypeScript ES Modules with Zod validation, Pino structured logging, Vitest tests, and SQLite by default. Postgres with pgvector supports semantic session retrieval for larger deployments.
Full walkthrough: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Development

```bash
npm run dev          # Hot-reload (tsx watch)
npm run setup        # Interactive setup wizard
npm run typecheck    # Type-check only
npm run lint         # ESLint
npm run test         # Run all tests
npm run check        # Full pre-commit: secrets + typecheck + lint + test
npm run build        # Compile to dist/
npm run start        # Production (from dist/)
```

## Docs
Getting started: [CONFIGURATION.md](docs/CONFIGURATION.md), [PLATFORMS.md](docs/PLATFORMS.md), [CUSTOMIZATION.md](docs/CUSTOMIZATION.md), [SETUP_EXAMPLES.md](docs/SETUP_EXAMPLES.md), [PERSONA.md](docs/PERSONA.md)

Operations: [SECURITY.md](docs/SECURITY.md), [INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md), [RELEASES.md](docs/RELEASES.md), [AWS.md](docs/AWS.md), [SCALING.md](docs/SCALING.md)

Design & internals: [ARCHITECTURE.md](docs/ARCHITECTURE.md), [PHILOSOPHY.md](docs/PHILOSOPHY.md), [ROADMAP.md](docs/ROADMAP.md), [IMPROVEMENTS.md](docs/IMPROVEMENTS.md), [VECTOR_MEMORY_IMPLEMENTATION_SPEC.md](docs/VECTOR_MEMORY_IMPLEMENTATION_SPEC.md), [VECTOR_DB_PLAN.md](docs/VECTOR_DB_PLAN.md), [MULTI_PLATFORM.md](docs/MULTI_PLATFORM.md), [PROMOTION_SNIPPETS.md](docs/PROMOTION_SNIPPETS.md), [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md)

## Contributing - Support - License
Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Support funds provider integrations, AI workflow improvements, and reliable releases:

- Patreon: https://www.patreon.com/c/garbanzobot
- GitHub Sponsors: https://github.com/sponsors/jjhickman
Main branch stability:
- `ci.yml` runs `npm run check` on PRs and pushes to `main`
- `CODEOWNERS` requires owner review coverage
- `pull_request_template.md` enforces verification checklist discipline
- Dependabot and release workflows keep npm, Docker, and published image paths maintained
Garbanzo is licensed under [Apache License 2.0](LICENSE). See `LICENSE_FAQ.md` for a quick guide.
