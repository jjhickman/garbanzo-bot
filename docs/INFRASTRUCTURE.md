# Infrastructure Reference
> Website: https://garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo


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

## Updating & Auto-Update

Manual (recommended while you want a human in the loop):

```bash
# with APP_VERSION pinned in .env: bump it, then
docker compose pull && docker compose up -d
# running `latest`: the same two commands pick up the newest release
```

`docker compose up -d` recreates only what changed — no `down` needed, and
never `down -v` (it deletes the auth/database volumes).

Optional hands-off updates via Watchtower: uncomment the `watchtower`
service in `docker-compose.yml` (label-filtered so it only touches
garbanzo, nightly at 05:30, prunes old images). Two things to accept
before enabling:

- It only acts when the container runs the `latest` tag. A pinned
  `APP_VERSION` (the safer default) makes Watchtower a no-op — pick one
  model, don't mix them.
- A bad release deploys itself while you sleep. Keep the `/health`
  monitor (Kuma) alerting and backups (see below) enabled if you turn
  this on; rollback is `APP_VERSION=<previous> docker compose up -d`.

## Local AI on the Pi (Ollama fallback)

Garbanzo routes short/casual queries to a local Ollama when one is reachable
(`OLLAMA_BASE_URL`), cutting cloud spend — and if every cloud provider is
down, local inference keeps the bot conversational instead of silent.

On a Raspberry Pi 5 (8 GB) this is practical with small models:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull gemma3:1b            # ~18-22 tok/s on Pi 5, ~1 GB RAM at Q4
# or: qwen2.5:1.5b (better multilingual), llama3.2:3b (smarter, ~2-5 tok/s)
```

Then in `.env`:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434   # host install; Ollama binds localhost by default
OLLAMA_MODEL=gemma3:1b
```

With the bot in Docker, point at the host: `OLLAMA_BASE_URL=http://host.docker.internal:11434`
and add `extra_hosts: ["host.docker.internal:host-gateway"]` to the garbanzo service.

Budget memory before enabling: the bot caps at 1 GB, Whisper (if used) holds
model RAM too, and a 1B model at Q4 adds ~1 GB. On an 8 GB Pi that fits; skip
3B+ models unless nothing else heavy runs. The default `qwen3:8b` model is for
workstation-class hosts.

## Storage & Backups

- Runtime data lives in `data/` (SQLite by default)
- Auth state lives in `baileys_auth/`
- Nightly backups are written to `data/backups/`
- Backups should be copied to external storage with encryption in production —
  the shipped host-side path (systemd timer, verification, restore runbook) is
  documented in [BACKUPS.md](BACKUPS.md)

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

<a id="monitoring--lan-firewall"></a>

## Monitoring & LAN firewall

If your Kuma dashboard is running on another host (for example `nas.local`), expose health on a reachable bind host:

```bash
HEALTH_BIND_HOST=0.0.0.0
HEALTH_PORT=3001
```

Then configure an HTTP monitor in Kuma to check:

```text
http://<garbanzo-host>:3001/health
```

Optional Prometheus scrape (if you enable it):

```text
http://<garbanzo-host>:3001/metrics
```

Optional (recommended) second monitor — alert when WhatsApp is disconnected or "connected but deaf":

```text
http://<garbanzo-host>:3001/health/ready
```

`/health/ready` returns:

- `200` when connected and not stale
- `503` when disconnected/connecting or stale

Recommended Kuma monitor settings:

- **Monitor type:** HTTP(s)
- **Method:** GET
- **Heartbeat interval:** 30s
- **Request timeout:** 5s
- **Retries:** 3
- **Accepted status codes:** 200-299
- **Resend interval:** 30m (or your preferred alert noise level)

Suggested setup on `nas.local`:

1. Add monitor name `garbanzo-health` with URL `http://<garbanzo-host>:3001/health`.
2. Save, then verify response body includes `status`, `stale`, `uptime`, and `backup` keys.
3. Add your notification channel (Discord, email, Slack, etc.) and run a test notification.
4. Optional second monitor: keyword check on `"stale":false` if you want alerting on stale chat activity, not just process uptime.

Keep network access restricted to trusted LAN/VPN segments.

If you expose port `3001` on your LAN for external monitoring, restrict it to your monitor host. For Docker deployments, the most reliable place is the `DOCKER-USER` iptables chain (so Docker's own rules can't bypass it):

```bash
# Allow Uptime Kuma (NAS) to reach /health
sudo iptables -I DOCKER-USER 1 -i <lan-iface> -p tcp -s 192.168.50.219 --dport 3001 -j ACCEPT

# Drop everyone else on LAN -> 3001
sudo iptables -I DOCKER-USER 2 -i <lan-iface> -p tcp --dport 3001 -j DROP
```

To persist across reboots on Ubuntu, install and save:

```bash
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```
