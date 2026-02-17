# Infrastructure Reference
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


> Reusable deployment reference for Garbanzo operators.

## Deployment Targets

Garbanzo is designed to run on a single primary host and can be adapted to many environments:

- Linux VM or bare-metal host
- Docker Compose deployment (default)
- Optional managed cloud runtime (EC2/ECS)

## Baseline Services

| Service | Default Port | Binding | Notes |
|---------|--------------|---------|-------|
| **Garbanzo** | `3001` (configurable) | `127.0.0.1` default (`HEALTH_BIND_HOST` configurable) | Health endpoints: `/health`, `/health/ready` |
| Ollama (optional) | `11434` | localhost | Local model routing for simple queries |
| Whisper STT (optional) | `8090` | localhost | Speech-to-text pipeline |
| Piper TTS (optional) | `10200` | configurable | Text-to-speech pipeline |

## Network Guidance

- Prefer private networking and outbound-only defaults where possible.
- If exposing health endpoints, restrict access to trusted monitors.
- Keep AI/provider endpoints outbound and avoid exposing internal helper services publicly.

## Docker Reference

Garbanzo ships with a production-oriented Docker setup:

- `Dockerfile` — multi-stage build, non-root runtime, healthcheck support
- `docker-compose.yml` — persisted volumes for auth/database state, restart policy, log rotation

```bash
# Build and run
docker compose up -d

# Check health
curl http://127.0.0.1:3001/health

# View logs
docker compose logs -f garbanzo
```

## Storage & Backups

- Runtime data lives in `data/` (SQLite by default)
- Auth state lives in `baileys_auth/`
- Nightly backups are written to `data/backups/`
- Backups should be copied to external storage with encryption in production

## Capacity Planning (Pragmatic)

Start simple and scale based on measured usage:

- Increase CPU/RAM vertically before adding architecture complexity.
- Keep persistent state local and backed up.
- For multi-instance scaling, plan a migration path from SQLite to Postgres first.

## Operator Checklist

- [ ] Health endpoint reachable only by trusted monitors
- [ ] Backup retention and restore test documented
- [ ] Secrets managed outside git (`.env`, SSM, or Secrets Manager)
- [ ] Release rollback command tested (`npm run release:deploy:verify`)
