# Garbanzo Bot

Garbanzo is a WhatsApp community bot (Baileys-based) that routes group mentions and commands to AI providers (configurable failover + optional local Ollama).

This image is built for small-to-medium community groups that want:

- Mention-driven responses (no surprise spam)
- Operations-friendly health endpoint (`/health`)
- Docker-first deployment with persistent auth + SQLite state

## Quick Start (Docker Compose)

1) Copy env template:

```bash
cp .env.example .env
```

2) Set required vars in `.env` (at minimum: `OWNER_JID` and one AI provider key).

3) Run a pinned release:

```bash
APP_VERSION=0.1.6 docker compose -f docker-compose.yml -f docker-compose.prod.yml pull garbanzo
APP_VERSION=0.1.6 docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
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

This repo publishes both GHCR and Docker Hub tags.

- `latest`
  - Most recent stable release
  - Only published for non-prerelease versions
- `0.1.6`
  - Semver tag without the leading `v`
- `v0.1.6`
  - Git tag style (kept for convenience)

All tags are multi-arch where available:

- `linux/amd64`
- `linux/arm64`

## Notes

- This container persists WhatsApp auth state and SQLite data via Docker volumes.
- Exposing the health port on your LAN is useful for Uptime Kuma, but you should restrict access to trusted hosts (firewall or reverse proxy).

## License

Garbanzo is source-available under the Prosperity Public License 3.0.0 (see `LICENSE` in the source repository). Noncommercial use is free; commercial use beyond the trial period requires a commercial license.

Source code and docs: https://github.com/jjhickman/garbanzo-bot

Docker Hub note: repository categories are set in the Docker Hub UI (the release workflow syncs overview + short description).
