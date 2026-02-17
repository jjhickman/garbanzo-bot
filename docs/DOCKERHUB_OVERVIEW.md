# Garbanzo Bot
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


Garbanzo is an AI chat operations platform packaged for Docker-first self-hosting. It routes prompts and commands across configurable providers (Claude/OpenAI/Gemini/Bedrock/OpenRouter) with optional local Ollama, then applies community workflows and integrations inside group chat.

This image is built for operators and small teams that want:

- Multi-provider AI routing with configurable failover order (Claude, OpenAI, Gemini, Bedrock, OpenRouter)
- Cloud + local hybrid inference to balance quality, latency, and cost
- Session memory with vector retrieval for long-horizon conversation recall
- Built-in workflow automations (summaries, events, moderation signals, recommendations)
- Built-in integrations (weather, transit, venues, news, books, D&D lookups)
- Operations-friendly health + readiness endpoints (`/health`, `/health/ready`)
- Docker-first deployment with persistent auth + SQLite or Postgres (pgvector) state

## Quick Start (Docker Compose)

1) Copy env template:

```bash
cp .env.example .env
```

2) Set required vars in `.env` (at minimum: `OWNER_JID` and one AI provider key).

3) Run a pinned release:

```bash
APP_VERSION=0.1.9 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull garbanzo
APP_VERSION=0.1.9 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Health check:

```bash
curl http://127.0.0.1:3001/health
```

Readiness (non-200 when disconnected/stale):

```bash
curl -i http://127.0.0.1:3001/health/ready
```

## Key Features

- **AI routing:** configurable provider failover order across Claude, OpenAI, Gemini, Bedrock, and OpenRouter with per-provider model overrides
- **Session memory:** conversations are sessionized by inactivity gap, extractively summarized, and embedded for semantic retrieval — the bot remembers what was discussed across sessions
- **Embedding providers:** deterministic hash embeddings by default, OpenAI `text-embedding-3-small` available with automatic fallback
- **Storage:** SQLite (default) or Postgres with pgvector for semantic session retrieval
- **Platforms:** WhatsApp (production), Slack, Discord (official API runtimes), unified demo at demo.garbanzobot.com
- **Integrations:** weather, transit (MBTA), venues, news, books, D&D dice/lookups/character sheets
- **Operations:** health/readiness endpoints, daily digest, backup integrity, rate limiting, retry queue

## Tags

This repository publishes both GHCR and Docker Hub tags from the same release workflow.

- `latest`
  - Most recent stable release
  - Only published for non-prerelease versions
- `0.1.9`
  - Semver tag without the leading `v`
- `v0.1.9`
  - Git tag style (kept for convenience)

All tags are multi-arch where available:

- `linux/amd64`
- `linux/arm64`

## Notes

- This container persists runtime auth state and database files via Docker volumes.
- For Postgres deployments, set `DB_DIALECT=postgres` and provide `DATABASE_URL` or `POSTGRES_*` connection vars.
- Session memory is enabled by default (`CONTEXT_SESSION_MEMORY_ENABLED=true`) and can be disabled via env var.
- Exposing the health port on your LAN is useful for Uptime Kuma, but restrict access to trusted hosts (firewall or reverse proxy).
- Security checks are part of release workflow: smoke-test + vulnerability scan (Trivy report artifact).

## License

Garbanzo is licensed under Apache License 2.0 (see `LICENSE` in the source repository).

Source code and docs: https://github.com/jjhickman/garbanzo-bot

Docker Hub note: repository categories are set in the Docker Hub UI (the release workflow syncs overview + short description).
