# Garbanzo

Self-hosted AI operations layer for group chat: Discord-first, WhatsApp-supported, and bridgeable into one conversation.

> Website: https://garbanzobot.com | Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo

![Garbanzo Logo](docs/assets/garbanzo-logo.svg)

[![Quality Gate](https://github.com/jjhickman/garbanzo-bot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jjhickman/garbanzo-bot/actions/workflows/ci.yml)
[![Docker Hub](https://img.shields.io/docker/v/jjhickman/garbanzo?label=dockerhub)](https://hub.docker.com/r/jjhickman/garbanzo)
[![Docker Pulls](https://img.shields.io/docker/pulls/jjhickman/garbanzo)](https://hub.docker.com/r/jjhickman/garbanzo)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Garbanzo brings AI-driven moderation and enrichment to communities where they already exist. It can answer questions, summarize busy threads, remember owner-approved facts, call local integrations, moderate with human review, and operate across multiple messaging platforms, including Discord and WhatsApp today, with Telegram and Matrix adapters in development.

## Why Garbanzo
- Runs anywhere, including self-hosted, with inspectable state: SQLite by default, optional Postgres, self-hosted Qdrant, and explicit-only shared memory. See [RAG federation](docs/RAG_FEDERATION.md).
- One core pipeline spans multiple messaging platforms (WhatsApp, Discord, Slack, Telegram, and more), with optional cross-platform bridging for mapped channels and groups. See [bridging](docs/BRIDGING.md).
- Multi-provider AI routing covers OpenAI, Anthropic, Gemini, Bedrock, OpenRouter, and *any* OpenAI API-compatible model provider, providing fallback and resiliency. See [configuration](docs/CONFIGURATION.md).
- WhatsApp support includes browser login and outbound safety designed around the Baileys account-risk model. See the [outbound safety ADR](docs/ADR-0001-whatsapp-outbound-safety.md).
- The persona model shapes the whole bot: a markdown file defines who your bot is, how it talks, and what it cares about, and every surface follows it, including its name, replies, and prompts. Locale, provider order, integrations, and groups are configuration too. See [customization](docs/CUSTOMIZATION.md).

<a id="features"></a>

## What It Does
- **AI chat and memory** - mention-gated chat, context compression, session summaries, curated facts, optional auto-extracted facts, semantic recall, shared facts, and read-only RAG federation. [Memory](docs/RAG_FEDERATION.md), [configuration](docs/CONFIGURATION.md)
- **Community workflows** - introductions, welcomes, summaries, event reminders, polls, profiles, recommendations, release notes, feedback, and owner digests. [Architecture](docs/ARCHITECTURE.md), [customization](docs/CUSTOMIZATION.md)
- **Integrations** - weather, transit, venues, news, books, web search, D&D dice/lookups, character PDFs, speech transcription, and language detection. [Configuration](docs/CONFIGURATION.md)
- **Band features** - an optional feature set adds songs, rehearsals, availability, setlists, practice agendas, idea capture, audio transcription, sections, and lyrics. [Band deployment](docs/BAND_FEATURES.md)
- **Moderation and safety** - mention gating, feature allowlists, prompt sanitization, owner alerts, rate limits, retry queues, and WhatsApp outbound controls. [Security](docs/SECURITY.md)
- **Operations** - health and readiness endpoints, `/admin`, Prometheus metrics, Grafana dashboards, Uptime Kuma checks, backups, release pinning, Compose, Helm, and systemd. [Monitoring](docs/MONITORING.md), [backups](docs/BACKUPS.md)

## See It In Action

Real interactions from communities powered by Garbanzo:

| Capability | Screenshot |
|---|---|
| Help and command discovery | <img src="docs/assets/screenshots/real/help-usage.jpg" width="300" alt="Help and command discovery" /> |
| First-time introduction welcome | <img src="docs/assets/screenshots/real/introductions-welcome.jpg" width="300" alt="Introduction welcome" /> |
| Local weather planning | <img src="docs/assets/screenshots/real/weather-report.jpg" width="300" alt="Weather report" /> |
| Transit alerts | <img src="docs/assets/screenshots/real/mbta-alerts.jpg" width="300" alt="Transit alerts" /> |
| Local recommendations | <img src="docs/assets/screenshots/real/restaurant-recommendations.jpg" width="300" alt="Restaurant recommendations" /> |

## Quick Start

Node.js 20+ is required either way. Docker Compose is only needed for the full-stack door below.

### Quick start (no Docker)

```bash
git clone https://github.com/jjhickman/garbanzo-bot.git
cd garbanzo-bot
npm ci
npm run setup
```

The wizard collects your AI provider keys, your messaging platform, and (for Discord) walks through the developer portal to gather a bot token, an owner user ID, and at least one channel to enable. When it finishes:

```bash
npm run build && npm start
```

Check your environment with `node dist/cli.js doctor` (Node version, config files, provider keys, optional binaries) and install a service that survives reboots with `node dist/cli.js service install` (systemd on Linux, launchd on macOS). Once the `garbanzo-bot` package is published, both become `garbanzo doctor` and `garbanzo service install`.

> Coming soon: once `garbanzo-bot` is published to npm, this door becomes `npx garbanzo-bot setup`, with no git clone required.

This path skips the monitoring stack, the RabbitMQ bridging transport, and container isolation, and defaults to keyword-only memory (`VECTOR_STORE=none`) instead of Qdrant semantic memory. See [docs/QUICKSTART.md](docs/QUICKSTART.md) for the full walkthrough, including updates, backups, running as a service, and enabling Qdrant.

### Full stack (Docker)

```bash
git clone https://github.com/jjhickman/garbanzo-bot.git
cd garbanzo-bot

cp .env.example .env
cp .env.discord.example .env.discord
cp config/discord-channels.example.json config/discord-channels.json
```

In `.env`, set:

```bash
COMPOSE_PROFILES=discord
AI_PROVIDER_ORDER=openai,anthropic
MONITORING_TOKEN=<pin-a-token-if-using-admin-or-monitoring>
```

In `.env.discord`, set `DISCORD_BOT_TOKEN`, `DISCORD_OWNER_ID`, and the channel config values used by `config/discord-channels.json`. Add at least one provider key in `.env`.

```bash
docker compose up -d
docker compose logs -f discord
curl http://127.0.0.1:3002/health
```

In an allowed Discord channel, mention the bot. For example, if the persona is Garbanzo:

```text
@garbanzo summarize what I missed today
@garbanzo is the train running on time?
```

For the guided wizard: `npm run setup`.

Optional WhatsApp instance:

```bash
cp .env.whatsapp.example .env.whatsapp
# In .env: COMPOSE_PROFILES=discord,whatsapp
# In .env.whatsapp: set OWNER_JID and WhatsApp options.
docker compose up -d
docker compose logs -f whatsapp
curl http://127.0.0.1:3001/health
```

This door adds the full stack this project supports: Prometheus/Grafana monitoring, the RabbitMQ bridging transport for larger topologies, Qdrant semantic memory, and per-container isolation. See [docs/BRIDGING.md](docs/BRIDGING.md) and [docs/MONITORING.md](docs/MONITORING.md).

Platform setup details live in [docs/PLATFORMS.md](docs/PLATFORMS.md).

<a id="platforms--login"></a>

## Platforms & Bridging
- **Discord** - default runtime using the official Gateway API, opt-in channels, owner escalation, welcomes, scheduled recaps, reminders, and band-mode roles.
- **WhatsApp** - fully supported through Baileys v7, browser login, linked-device auth persistence, group config, and anti-ban outbound safety.
- **Slack** - Events API support plus a local demo mode for pipeline checks.
- **Telegram and Matrix** - the platform architecture supports them; adapters are in development.

Bridging connects channels and groups across platforms into a single conversation while keeping each bot instance independent. Transports scale from a simple two-instance setup to a message broker for larger topologies, and instances can share one account or stay fully isolated. Setup, topology options, and rate-safety details live in [docs/BRIDGING.md](docs/BRIDGING.md).

## Memory & Knowledge
- **Conversation context** keeps recent chat available to the model.
- **Session memory** summarizes inactive stretches and stores long-horizon recall.
- **Curated facts** are owner-managed through `!memory`; optional auto-extraction stays local and capped.
- **Shared facts** are explicit only: `!memory share <id>` writes a namespaced fact to the shared Qdrant collection for peer instances.
- **RAG federation** searches read-only Qdrant sources such as runbooks or archives at prompt time without writing to them.

See [docs/RAG_FEDERATION.md](docs/RAG_FEDERATION.md), [docs/BRIDGING.md](docs/BRIDGING.md), and [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

<a id="ai-providers--routing"></a>

## AI Routing

Set `AI_PROVIDER_ORDER` to choose failover order across OpenAI, Anthropic, Gemini, Bedrock, and OpenRouter, and point simple queries at any OpenAI API-compatible model provider, local or remote. Native tool calling is controlled by `AI_TOOL_CALLING`; when enabled, providers can call Garbanzo integrations during a reply.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Deployment

Compose is the default release path:

```bash
APP_VERSION=3.2.0 docker compose pull
APP_VERSION=3.2.0 docker compose up -d
```

Production overlay:

```bash
APP_VERSION=3.2.0 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
APP_VERSION=3.2.0 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Kubernetes operators can install one bot instance per Helm release:

```bash
helm install garbanzo ./deploy/helm/garbanzo --set platform=discord --set instanceId=discord-main
```

See [deploy/helm/README.md](deploy/helm/README.md). Native Node deployments can use [scripts/garbanzo.service](scripts/garbanzo.service) with the same layered env files.

<a id="monitoring--observability"></a>

## Monitoring & Backups

`MONITORING_TOKEN` gates `/metrics`, `/admin`, Prometheus scrapes, and the Grafana admin password fallback. With `COMPOSE_PROFILES=discord,monitoring` or `discord,whatsapp,monitoring`, the dashboard has a `$job` picker for all instances or one service at a time. Monitoring services should watch `/health/ready` on the configured port for each messaging instance.

<p align="center">
  <img src="docs/assets/screenshots/real/kuma-dashboard.png" width="900" alt="Uptime Kuma dashboard monitoring Garbanzo health endpoints" />
</p>

Nightly off-machine backup guidance covers credentials, database state, verification, retention, and restore: [docs/BACKUPS.md](docs/BACKUPS.md). Monitoring setup and metrics are in [docs/MONITORING.md](docs/MONITORING.md).

<a id="configuration"></a>

## Customizing For Your Community

Garbanzo is configurable first. The default persona is a Boston meetup WhatsApp community bot.

- Persona identity comes from [docs/PERSONA.md](docs/PERSONA.md) and optional platform persona files.
- Locale behavior comes from env values for weather, transit, venue search, news, web search, and language settings.
- Discord channels live in `config/discord-channels.json`; WhatsApp groups live in `config/groups.json`.
- Feature allowlists, mention requirements, owner controls, provider order, vector memory, and bridge identity are env/config choices.

See [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md), [docs/CONFIGURATION.md](docs/CONFIGURATION.md), and [docs/PLATFORMS.md](docs/PLATFORMS.md).

<a id="architecture--stack"></a>

## Development

```bash
npm run dev          # Hot reload
npm run setup        # Interactive setup wizard
npm run typecheck    # Type-check only
npm run lint         # ESLint
npm run test         # Vitest
npm run check        # Secrets, deps audit, typecheck, lint, tests
npm run build        # Compile to dist/
npm run start        # Run dist/
```

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Project principles: [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md).

## Docs

Getting started: [QUICKSTART.md](docs/QUICKSTART.md), [CONFIGURATION.md](docs/CONFIGURATION.md), [PLATFORMS.md](docs/PLATFORMS.md), [CUSTOMIZATION.md](docs/CUSTOMIZATION.md), [PERSONA.md](docs/PERSONA.md)

Operations: [BRIDGING.md](docs/BRIDGING.md), [RAG_FEDERATION.md](docs/RAG_FEDERATION.md), [MONITORING.md](docs/MONITORING.md), [BACKUPS.md](docs/BACKUPS.md), [SECURITY.md](docs/SECURITY.md), [RELEASES.md](docs/RELEASES.md), [BAND_FEATURES.md](docs/BAND_FEATURES.md), [POSTGRES_MIGRATION_RUNBOOK.md](docs/POSTGRES_MIGRATION_RUNBOOK.md), [ADR-0001-whatsapp-outbound-safety.md](docs/ADR-0001-whatsapp-outbound-safety.md)

Design and development: [ARCHITECTURE.md](docs/ARCHITECTURE.md), [PHILOSOPHY.md](docs/PHILOSOPHY.md), [ROADMAP.md](docs/ROADMAP.md), [AWS.md](docs/AWS.md), [SCALING.md](docs/SCALING.md), [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md)

## Contributing - Support - License

Contributions are welcome through pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md). Before pushing, run:

```bash
npm run check
npm run gh:dependabot
```

Support funds provider integrations, AI workflow improvements, and release maintenance:

- Patreon: https://www.patreon.com/c/garbanzobot
- GitHub Sponsors: https://github.com/sponsors/jjhickman

Garbanzo is licensed under [Apache License 2.0](LICENSE). See [LICENSE_FAQ.md](LICENSE_FAQ.md).
