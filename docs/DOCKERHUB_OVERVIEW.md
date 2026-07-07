# Garbanzo Bot
> Website: https://garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


Garbanzo is an AI chat operations platform packaged for Docker-first self-hosting. It routes prompts and commands across configurable providers with optional local OpenAI API-compatible providers, then applies community workflows and integrations inside group chat.

This image is built for operators and small teams that want:

- Multi-provider AI routing with configurable failover order across OpenAI, Anthropic, Gemini, Bedrock, OpenRouter, plus any local OpenAI API-compatible provider
- **Native tool calling**: the model invokes weather/transit/venues/news/books/memory integrations mid-reply
- Session memory with vector retrieval, plus **automatic community-memory extraction** (opt-in)
- Cross-instance bridging for mapped Discord channels and WhatsApp groups over HTTP or AMQP
- Multi-instance deployment with `INSTANCE_ID`, isolated volumes, and same-account WhatsApp linked-device patterns
- Built-in workflow automations (summaries, events + reminders, weekly recaps, moderation signals, recommendations)
- Built-in integrations (weather, transit, venues, news, books, D&D lookups)
- Operations: health/readiness endpoints, token-gated `/admin` usage & cost page, Prometheus `/metrics`, and a pre-provisioned Grafana dashboard via the compose `monitoring` profile
- Verified off-machine backups (systemd timer + restore runbook) and anti-ban outbound safety for WhatsApp
- Docker-first deployment with persistent auth, SQLite or Postgres state, and a self-hosted Qdrant vector store for semantic recall
- RAG federation for read-only Qdrant sources at prompt time
- Helm chart under `deploy/helm/` for Kubernetes operators
- Band features (`BAND_FEATURES_ENABLED`): an optional feature set for bands with a song catalog, rehearsal scheduling and reminders, availability tracking, setlists, and song idea capture with audio transcription

## Quick Start (Docker Compose)

1) Copy env templates:

```bash
cp .env.example .env
cp .env.discord.example .env.discord
# Optional WhatsApp instance:
# cp .env.whatsapp.example .env.whatsapp
```

2) In `.env`, set `COMPOSE_PROFILES=discord`, one AI provider key, and
`MONITORING_TOKEN` if you enable monitoring. In `.env.discord`, set
`DISCORD_BOT_TOKEN` and `DISCORD_OWNER_ID`.

3) Run a pinned release:

```bash
APP_VERSION=3.2.0 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
APP_VERSION=3.2.0 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Health check:

```bash
curl http://127.0.0.1:3002/health
```

Readiness (non-200 when disconnected/stale):

```bash
curl -i http://127.0.0.1:3002/health/ready
```

To run WhatsApp too, copy `.env.whatsapp.example` to `.env.whatsapp`, set
`OWNER_JID`, and use `COMPOSE_PROFILES=discord,whatsapp`. To add Prometheus and
Grafana, append `,monitoring`, set `METRICS_ENABLED=true`, and set
`MONITORING_TOKEN`.

## Key Features

- **AI routing:** configurable provider failover order across OpenAI, Anthropic, Gemini, Bedrock, and OpenRouter with per-provider model overrides
- **Tool calling:** opt-in native function calling (`AI_TOOL_CALLING`) lets members ask naturally ("is the red line running?") without bang commands
- **Community memory:** owner-curated facts plus opt-in automatic extraction (`MEMORY_AUTO_EXTRACT`), injected into the AI prompt and managed with `!memory`
- **Session memory:** conversations are sessionized by inactivity gap, extractively summarized, and embedded for semantic retrieval, so the bot remembers what was discussed across sessions
- **Vector memory:** session summaries and community facts are embedded into a self-hosted Qdrant store, with automatic keyword fallback when Qdrant is unavailable
- **RAG federation:** read-only Qdrant sources from `config/rag-sources.json` can add bounded source hits to prompts
- **Storage:** SQLite (default) or Postgres for relational state; Qdrant for vectors
- **Platforms:** Discord (default Gateway runtime with opt-in channels), WhatsApp (Baileys runtime with browser login and anti-ban outbound safety), Slack (support plus demo mode)
- **Bridging:** mapped chats relay between instances through HTTP or AMQP, with per-route summary or verbatim modes
- **Multi-instance:** `INSTANCE_ID` separates deployment identity, metrics, shared-fact ids, and local vector collections; same-account WhatsApp deployments use separate linked-device auth volumes
- **Band features:** `BAND_FEATURES_ENABLED=true` turns on the band feature set (`!song`, `!rehearsal`, `!available`, `!setlist`, `!agenda`, `!idea`, `!section`, `!lyrics`)
- **Integrations:** weather, transit (MBTA), venues, news, books, D&D dice/lookups/character sheets
- **Operations:** health/readiness endpoints, `/admin` usage & cost page, Prometheus metrics + Grafana dashboard (compose `monitoring` profile), daily digest + weekly recap, verified backups, anti-ban outbound safety, rate limiting, retry queue
- **Kubernetes:** Helm chart in `deploy/helm/` for operators who run Garbanzo on a cluster

## Tags

This repository publishes both GHCR and Docker Hub tags from the same release workflow.

- `latest`
  - Most recent stable release
  - Only published for non-prerelease versions
- `3.1.0`
  - Semver tag without the leading `v`
- `v3.1.0`
  - Git tag style (kept for convenience)

All tags are multi-arch where available:

- `linux/amd64`
- `linux/arm64`

## Notes

- This container persists runtime auth state and database files via Docker volumes.
- For Postgres deployments, set `DB_DIALECT=postgres` and provide `DATABASE_URL` or `POSTGRES_*` connection vars.
- The default compose file includes a Qdrant service for vector memory. Set `VECTOR_STORE=none` for keyword-only search without Qdrant.
- Session memory is enabled by default (`CONTEXT_SESSION_MEMORY_ENABLED=true`) and can be disabled via env var.
- Exposing the health port on your LAN is useful for Uptime Kuma, but restrict access to trusted hosts (firewall or reverse proxy).
- Security checks are part of release workflow: smoke-test + vulnerability scan (Trivy report artifact).

## License

Garbanzo is licensed under Apache License 2.0 (see `LICENSE` in the source repository).

Source code and docs: https://github.com/jjhickman/garbanzo-bot

Docker Hub note: repository categories are set in the Docker Hub UI (the release workflow syncs overview + short description).
