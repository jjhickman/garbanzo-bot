# Garbanzo Bot
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


Garbanzo is an AI chat operations platform packaged for Docker-first self-hosting. It routes prompts and commands across configurable providers (Claude/OpenAI/Gemini/OpenRouter) with optional local Ollama, then applies community workflows and integrations inside group chat.

This image is built for operators and small teams that want:

- Multi-provider AI routing with configurable failover order
- Cloud + local hybrid inference to balance quality, latency, and cost
- Built-in workflow automations (summaries, events, moderation signals, recommendations)
- Built-in integrations (weather, transit, venues, news, books, D&D lookups)
- Operations-friendly health + readiness endpoints (`/health`, `/health/ready`)
- Docker-first deployment with persistent auth + SQLite state

## Quick Start (Docker Compose)

1) Copy env template:

```bash
cp .env.example .env
```

2) Set required vars in `.env` (at minimum: `OWNER_JID` and one AI provider key).

3) Run a pinned release:

```bash
APP_VERSION=0.1.8 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull garbanzo
APP_VERSION=0.1.8 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Health check:

```bash
curl http://127.0.0.1:3001/health
```

Readiness (non-200 when disconnected/stale):

```bash
curl -i http://127.0.0.1:3001/health/ready
```

Troubleshooting: if `/health` reports `status=connected` but `/health/ready` is 503 with `stale=true` immediately after a reconnect, you are likely running an older build where staleness was carried over across reconnects. Upgrade to a newer release, or as a short-term workaround send any message in a monitored chat to refresh `lastMessageAt`.

## Tags

This repository publishes both GHCR and Docker Hub tags from the same release workflow.

- `latest`
  - Most recent stable release
  - Only published for non-prerelease versions
- `0.1.8`
  - Semver tag without the leading `v`
- `v0.1.8`
  - Git tag style (kept for convenience)

All tags are multi-arch where available:

- `linux/amd64`
- `linux/arm64`

## Notes

- This container persists runtime auth state and SQLite data via Docker volumes.
- Exposing the health port on your LAN is useful for Uptime Kuma, but restrict access to trusted hosts (firewall or reverse proxy).
- Security checks are part of release workflow: smoke-test + vulnerability scan (Trivy report artifact).

## License

Garbanzo is licensed under Apache License 2.0 (see `LICENSE` in the source repository).

Source code and docs: https://github.com/jjhickman/garbanzo-bot

Docker Hub note: repository categories are set in the Docker Hub UI (the release workflow syncs overview + short description).
