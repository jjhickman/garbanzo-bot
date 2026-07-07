# Garbanzo

Self-hosted AI operations layer for group chat: Discord-first, WhatsApp-supported, and bridgeable into one conversation.

> Website: https://garbanzobot.com | Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo

![Garbanzo Logo](docs/assets/garbanzo-logo.svg)

[![Quality Gate](https://github.com/jjhickman/garbanzo-bot/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jjhickman/garbanzo-bot/actions/workflows/ci.yml)
[![Docker Hub](https://img.shields.io/docker/v/jjhickman/garbanzo?label=dockerhub)](https://hub.docker.com/r/jjhickman/garbanzo)
[![Docker Pulls](https://img.shields.io/docker/pulls/jjhickman/garbanzo)](https://hub.docker.com/r/jjhickman/garbanzo)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Garbanzo runs useful AI workflows where a group already talks. It can answer questions, summarize busy threads, remember owner-approved facts, call local integrations, moderate with human review, and operate across Discord and WhatsApp instances from one codebase.

## Why Garbanzo
- Runs on your hardware with inspectable state: SQLite by default, optional Postgres, self-hosted Qdrant, and explicit-only shared memory. See [RAG federation](docs/RAG_FEDERATION.md).
- One core pipeline spans Discord and WhatsApp, with optional cross-platform bridging for mapped channels and groups. See [bridging](docs/BRIDGING.md).
- Multi-provider AI routing covers OpenAI, Anthropic, Gemini, Bedrock, OpenRouter, and local Ollama fallback. See [configuration](docs/CONFIGURATION.md).
- WhatsApp support includes browser login and outbound safety designed around the Baileys account-risk model. See the [outbound safety ADR](docs/ADR-0001-whatsapp-outbound-safety.md).
- Persona, locale, provider order, integrations, groups, and deployment identity are configuration. Garbanzo is the framework; your instance can be named for your community.

<a id="features"></a>

## What It Does
- **AI chat and memory** - mention-gated chat, context compression, session summaries, curated facts, optional auto-extracted facts, semantic recall, shared facts, and read-only RAG federation. [Memory](docs/RAG_FEDERATION.md), [configuration](docs/CONFIGURATION.md)
- **Community workflows** - introductions, welcomes, summaries, event reminders, polls, profiles, recommendations, release notes, feedback, and owner digests. [Architecture](docs/ARCHITECTURE.md), [customization](docs/CUSTOMIZATION.md)
- **Integrations** - weather, transit, venues, news, books, web search, D&D dice/lookups, character PDFs, speech transcription, and language detection. [Configuration](docs/CONFIGURATION.md)
- **Band mode** - Remy mode on Discord adds songs, rehearsals, availability, setlists, practice agendas, idea capture, audio transcription, sections, and lyrics. [Remy deploy](docs/REMY_DEPLOY.md)
- **Moderation and safety** - mention gating, feature allowlists, prompt sanitization, owner alerts, rate limits, retry queues, and WhatsApp outbound controls. [Security](docs/SECURITY.md)
- **Operations** - health and readiness endpoints, `/admin`, Prometheus metrics, Grafana dashboards, Uptime Kuma checks, backups, release pinning, Compose, Helm, and systemd. [Monitoring](docs/MONITORING.md), [backups](docs/BACKUPS.md)

## See It In Action

Real outputs from deployed Garbanzo instances:

| Capability | Screenshot |
|---|---|
| Help and command discovery | <img src="docs/assets/screenshots/real/help-usage.jpg" width="300" alt="Help and command discovery" /> |
| First-time introduction welcome | <img src="docs/assets/screenshots/real/introductions-welcome.jpg" width="300" alt="Introduction welcome" /> |
| Local weather planning | <img src="docs/assets/screenshots/real/weather-report.jpg" width="300" alt="Weather report" /> |
| Transit alerts | <img src="docs/assets/screenshots/real/mbta-alerts.jpg" width="300" alt="Transit alerts" /> |
| Local recommendations | <img src="docs/assets/screenshots/real/restaurant-recommendations.jpg" width="300" alt="Restaurant recommendations" /> |

## Quick Start

Requirements: Docker and Docker Compose for the default path. Node.js 20+ is only needed for the setup wizard and local development.

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

For the guided wizard:

```bash
npm run setup
```

Optional WhatsApp instance:

```bash
cp .env.whatsapp.example .env.whatsapp
# In .env: COMPOSE_PROFILES=discord,whatsapp
# In .env.whatsapp: set OWNER_JID and WhatsApp options.
docker compose up -d
docker compose logs -f whatsapp
curl http://127.0.0.1:3001/health
```

Platform setup details live in [docs/PLATFORMS.md](docs/PLATFORMS.md).

<a id="platforms--login"></a>

## Platforms & Bridging
- **Discord** - default runtime using the official Gateway API, opt-in channels, owner escalation, welcomes, scheduled recaps, reminders, and band-mode roles.
- **WhatsApp** - fully supported through Baileys v7, browser login, linked-device auth persistence, group config, and anti-ban outbound safety.
- **Slack** - Events API support plus a local demo mode for pipeline checks.

Bridging connects one Discord channel and one WhatsApp group into a single operating room while keeping each bot instance independent. HTTP transport fits two instances; the `broker` profile adds RabbitMQ for larger or longer-outage topologies. Same-account WhatsApp companion instances use `WHATSAPP_CHAT_SCOPE=configured` and `WHATSAPP_SET_PROFILE_NAME=false` on secondary linked devices; hard isolation uses a second WhatsApp number. Start with [docs/BRIDGING.md](docs/BRIDGING.md).

## Memory & Knowledge
- **Conversation context** keeps recent chat available to the model.
- **Session memory** summarizes inactive stretches and stores long-horizon recall.
- **Curated facts** are owner-managed through `!memory`; optional auto-extraction stays local and capped.
- **Shared facts** are explicit only: `!memory share <id>` writes a namespaced fact to the shared Qdrant collection for peer instances.
- **RAG federation** searches read-only Qdrant sources such as runbooks or archives at prompt time without writing to them.

See [docs/RAG_FEDERATION.md](docs/RAG_FEDERATION.md), [docs/BRIDGING.md](docs/BRIDGING.md), and [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

<a id="ai-providers--routing"></a>

## AI Routing

Set `AI_PROVIDER_ORDER` to choose cloud failover order across OpenAI, Anthropic, Gemini, Bedrock, and OpenRouter. Ollama can handle simple local queries through `OLLAMA_BASE_URL` and `OLLAMA_MODEL`. Native tool calling is controlled by `AI_TOOL_CALLING`; when enabled, providers can call Garbanzo integrations during a reply.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Deployment

Compose is the default release path:

```bash
APP_VERSION=3.1.0 docker compose pull
APP_VERSION=3.1.0 docker compose up -d
```

Production overlay:

```bash
APP_VERSION=3.1.0 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
APP_VERSION=3.1.0 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Kubernetes operators can install one bot instance per Helm release:

```bash
helm install garbanzo ./deploy/helm/garbanzo --set platform=discord --set instanceId=discord-main
```

See [deploy/helm/README.md](deploy/helm/README.md). Native Node deployments can use [scripts/garbanzo.service](scripts/garbanzo.service) with the same layered env files.

<a id="monitoring--observability"></a>

## Monitoring & Backups

`MONITORING_TOKEN` gates `/metrics`, `/admin`, Prometheus scrapes, and the Grafana admin password fallback. With `COMPOSE_PROFILES=discord,monitoring` or `discord,whatsapp,monitoring`, the dashboard has a `$job` picker for all instances or one service at a time. Uptime Kuma should watch `/health/ready` on `3002` for Discord and `3001` for WhatsApp.

<p align="center">
  <img src="docs/assets/screenshots/real/kuma-dashboard.png" width="900" alt="Uptime Kuma dashboard monitoring Garbanzo health endpoints" />
</p>

Nightly off-machine backup guidance covers credentials, database state, verification, retention, and restore: [docs/BACKUPS.md](docs/BACKUPS.md). Monitoring setup and metrics are in [docs/MONITORING.md](docs/MONITORING.md).

<a id="configuration"></a>

## Customizing For Your Community

Garbanzo is configurable first. The flagship deployment happens to be Boston-area because its env values, group mappings, persona files, and transit settings are Boston-specific.

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

Getting started: [CONFIGURATION.md](docs/CONFIGURATION.md), [PLATFORMS.md](docs/PLATFORMS.md), [CUSTOMIZATION.md](docs/CUSTOMIZATION.md), [PERSONA.md](docs/PERSONA.md)

Operations: [BRIDGING.md](docs/BRIDGING.md), [RAG_FEDERATION.md](docs/RAG_FEDERATION.md), [MONITORING.md](docs/MONITORING.md), [BACKUPS.md](docs/BACKUPS.md), [SECURITY.md](docs/SECURITY.md), [RELEASES.md](docs/RELEASES.md), [REMY_DEPLOY.md](docs/REMY_DEPLOY.md), [POSTGRES_MIGRATION_RUNBOOK.md](docs/POSTGRES_MIGRATION_RUNBOOK.md), [ADR-0001-whatsapp-outbound-safety.md](docs/ADR-0001-whatsapp-outbound-safety.md)

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
