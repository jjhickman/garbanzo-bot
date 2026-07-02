# Monitoring
> Live demo: https://demo.garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo

Three layers, all optional, all runnable on a Pi-class host:

| Layer | What it gives you | Cost |
|---|---|---|
| `/admin` page | Today's AI spend, provider mix, per-group activity, anti-ban counters | Built in — zero setup |
| Uptime Kuma | Up/down alerting (push, Telegram, email, …) | One small container |
| **Prometheus + Grafana** | Historical graphs of everything below, 30-day retention | Two containers, ~600MB RAM combined |

## Prometheus + Grafana (the `monitoring` profile)

### Enable (two steps, once)

```bash
# 1. In .env:
#    METRICS_ENABLED=true
#    WHATSAPP_LOGIN_TOKEN=<pin a value>   # must be pinned — it authenticates scrapes
#                                         # AND doubles as the Grafana admin password
#    GRAFANA_ADMIN_PASSWORD=<optional>    # only if you want a separate Grafana login

# 2. Start the stack alongside the bot:
docker compose --profile monitoring up -d
```

That's it. The Prometheus container reads `WHATSAPP_LOGIN_TOKEN` from your `.env`
at start (via the compose file) and authenticates its scrapes with it —
no token files to create. If the token isn't set, the container exits with a
clear error instead of scraping blind.

- **Grafana**: `http://<pi>:3000` — the **Garbanzo — Community Ops** dashboard
  is pre-provisioned and loads immediately. Anonymous LAN users can *view*;
  editing needs the admin login (`admin` / your `WHATSAPP_LOGIN_TOKEN`, or
  `GRAFANA_ADMIN_PASSWORD` if you set one). Sharing the token is a
  deliberate single-owner convenience — note it also guards the WhatsApp
  re-link page, so set a separate `GRAFANA_ADMIN_PASSWORD` if others can
  reach Grafana on your network.
  Grafana listens on the LAN by design (view from any device); if your LAN is
  untrusted, restrict port 3000 with an iptables `DOCKER-USER` allowlist or
  bind it to `127.0.0.1` in compose and front it with a reverse proxy.
- **Prometheus**: `http://127.0.0.1:9090` (localhost-only, for debugging queries).
- Retention: 30 days. Memory: both containers are capped at 300MB each.
- Disable anytime: `docker compose --profile monitoring down` (bot unaffected;
  add `-v` only if you also want to drop the metrics history — never affects
  bot data, which lives in separate volumes).

### The dashboard, row by row (what to actually look at)

- **Community Activity** — messages/hour and bot replies/hour stacked by group
  (which groups are alive, where the bot earns its keep), active users today,
  owner DMs, and rate-limited request counts.
- **AI Usage & Cost** — today's spend against the $1 alert threshold, cost per
  day **by provider**, requests by provider (watch failovers show up as
  Anthropic slices), tool calls by tool (which integrations members actually
  use), and an errors panel (AI failures + failed tool calls).
- **WhatsApp Health** — connected/down stat, seconds since last inbound
  message, staleness flag, reconnects per 6h (a rising reconnect rate is the
  early warning for connection trouble).
- **Anti-ban Safety** — risk score trend, sent-per-hour vs held outbound, and
  a PAUSED banner if the safety layer stops sends. This is the page to check
  before raising `WHATSAPP_SAFETY_*` limits.
- **Community Features** — memory facts by source (watch `(auto)` grow),
  event reminders pending/sent, moderation flags by group.
- **System & Backups** — RSS vs the 1GB watchdog line, uptime, and two stats
  that should always be green: backup present + backup integrity.

### Metrics reference

All metrics are prefixed `garbanzo_`. Counters reset on restart —
`rate()`/`increase()` handle that. Community/usage families:
`messages_total{group}`, `bot_responses_total{group}`,
`ai_requests_total{provider}`, `ai_cost_usd_total{provider}`,
`daily_cost_usd`, `daily_active_users{group}`, `tool_calls_total{tool,outcome}`,
`ai_errors_total{group}`, `moderation_flags_total{group}`,
`rate_limited_total`, `owner_dms_total`, `memory_facts{source}`,
`event_reminders_pending`, `event_reminders_sent_total` — plus the original
ops families (connection, staleness, reconnects, memory, anti-ban, backups).

Scrape auth: `/metrics` accepts `Authorization: Bearer <token>` (what
Prometheus uses) or `?token=` (handy for `curl`).

## Uptime Kuma (alerting)

Kuma pages you; Grafana explains why. Recommended monitors:

| Monitor | URL | Trigger |
|---|---|---|
| HTTP | `http://<pi>:3001/health/ready` | non-200 → WhatsApp disconnected |
| Keyword | `http://<pi>:3001/health`, keyword `"integrityOk":true` | nightly backup went bad |
| Keyword | `http://<pi>:3001/health`, keyword `"paused":false` | anti-ban layer paused sends |

## Grafana alerting (optional)

If you'd rather alert from Grafana than Kuma, the highest-value rules:
`garbanzo_connection_status{status="connected"} == 0` for 2m,
`garbanzo_backup_integrity_ok == 0`, `garbanzo_daily_cost_usd > 1`,
`garbanzo_whatsapp_safety_paused == 1`, and
`increase(garbanzo_reconnect_count[1h]) > 5`.
