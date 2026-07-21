# Monitoring
> Website: https://garbanzobot.com  |  Docker Hub: https://hub.docker.com/r/jjhickman/garbanzo

Three optional monitoring layers can run on a Pi-class host:

| Layer | What it gives you | Cost |
|---|---|---|
| `/admin` page | Overview, Memory ("Lore"), Bridges, Health, plus today's AI spend/provider mix/per-community activity | Built in |
| HTTP health-check monitor | Up/down alerting through the monitor you already use | External or optional |
| **Prometheus + Grafana** | Historical graphs of everything below, 30-day retention | Two containers, ~600MB RAM combined |

## Prometheus + Grafana (the `monitoring` profile)

<p align="center">
  <img src="assets/screenshots/site/grafana-community-ops.png" width="900" alt="The pre-provisioned Community Ops dashboard" />
</p>

### Enable (two steps, once)

```bash
# 1. In .env:
#    COMPOSE_PROFILES=discord,monitoring
#    METRICS_ENABLED=true
#    MONITORING_TOKEN=<pin a value>       # authenticates /metrics, /admin, scrapes,
#                                         # and Grafana admin login unless overridden
#    GRAFANA_ADMIN_PASSWORD=<optional>    # only if you want a separate Grafana login

# 2. Start the selected profiles:
docker compose up -d
```

Use `COMPOSE_PROFILES=discord,whatsapp,monitoring` to run both platform
instances and the monitoring stack together.

That's it. The Prometheus container reads `MONITORING_TOKEN` from your `.env`
at start (via the compose file) and authenticates its scrapes with it —
no token files to create. If the token isn't set, the container exits with a
clear error instead of scraping blind.

- **Grafana**: `http://<host>:${GRAFANA_PORT:-3000}` exposes the
  **Garbanzo - Community Ops** dashboard, which is pre-provisioned and loads
  immediately. Anonymous LAN users can *view*;
  editing needs the admin login (`admin` / your `MONITORING_TOKEN`, or
  `GRAFANA_ADMIN_PASSWORD` if you set one). Set a separate
  `GRAFANA_ADMIN_PASSWORD` if others can reach Grafana on your network.
  Grafana listens on the LAN by design. If your LAN is untrusted, restrict
  `${GRAFANA_PORT:-3000}` with an iptables `DOCKER-USER` allowlist or
  bind it to `127.0.0.1` in compose and front it with a reverse proxy.
- **Prometheus**: `http://127.0.0.1:${PROMETHEUS_PORT:-9090}` is localhost-only for debugging queries.
- **Scrape targets**: `discord:${DISCORD_HEALTH_PORT:-3002}`, `whatsapp:${WHATSAPP_HEALTH_PORT:-3001}`, `telegram:${TELEGRAM_HEALTH_PORT:-3005}`, and `matrix:${MATRIX_HEALTH_PORT:-3004}`.
  If a platform profile is not running, that target is down by design. The
  dashboard filters on bot metrics rather than Prometheus `up`, so not-enabled
  jobs show up as absent/no data instead of red application failures.
- **Dashboard instance picker**: the `$job` variable lets you view all bot
  instances together or select one platform scrape job at a time. The
  `$instance` variable uses Prometheus' scrape `instance` label for operators
  who run compose-copy instances.
- **Compose-copy instances**: add one scrape job per copied bot service, using
  a unique `job_name` such as `whatsapp-band` and the copied service/port as
  the target. Do not add an `instance_id` metric label; Prometheus already
  attaches `job` and `instance` labels at scrape time.
- Retention: 30 days. Memory: both containers are capped at 300MB each.
- Disable anytime: remove `monitoring` from `COMPOSE_PROFILES` and run
  `docker compose up -d`. Add `-v` only if you also want to drop the metrics
  history; bot data lives in separate volumes.

### The dashboard, row by row (what to actually look at)

- **Platform Connection** — connected/down state where the adapter reports it,
  seconds since last inbound message, staleness flag, and reconnects per 6h.
- **Message Flow** — messages/hour and bot replies/hour stacked by group,
  active users today, owner DMs, rate-limited request counts, and Telegram
  MarkdownV2 fallback sends.
- **AI Provider Fallback and Latency** — requests by provider, daily average
  latency by provider, cost per provider, tool calls, and AI/tool errors.
- **Bridge Health** — outbox depth and oldest pending age, sent/failed/dead
  outcomes by route, summary-buffer depth/flushes, dedup hits, WhatsApp
  outbound-safety holds, and relay delivery latency.
- **Memory Growth** — memory facts by source, `save_community_memory`
  rejection reasons, event reminders, moderation flags, and process memory.

### Metrics reference

All metrics are prefixed `garbanzo_`. Counters reset on restart —
`rate()`/`increase()` handle that. Community/usage families:
`messages_total{group}`, `bot_responses_total{group}`,
`ai_requests_total{provider}`, `ai_cost_usd_total{provider}`,
`daily_cost_usd`, `ai_latency_ms_avg{provider}`,
`daily_active_users{group}`, `tool_calls_total{tool,outcome}`,
`ai_errors_total{group}`, `moderation_flags_total{group}`,
`rate_limited_total`, `owner_dms_total`, `markdown_v2_fallbacks_total{platform}`,
`memory_facts{source}`, `memory_save_rejections_total{reason}`,
`event_reminders_pending`, `event_reminders_sent_total` — plus the original
ops families (connection, staleness, reconnects, memory, anti-ban, backups).

Bridge metrics:
`bridge_outbox_depth` and `bridge_outbox_oldest_pending_age_seconds` are
scrape-time gauges from the durable outbox. `bridge_summary_buffer_size{route}`
is a scrape-time gauge from the summary buffer. Event-time counters are
`bridge_sent_total{route}`, `bridge_failed_total{route}`,
`bridge_dead_lettered_total{route}`, `bridge_summary_flushes_total{route}`,
`bridge_seen_dedup_hits_total{route}`, and
`bridge_held_by_outbound_safety_total{route}`. Relay delivery latency is
reported as rolling-window gauges:
`bridge_delivery_latency_seconds_min{route}`,
`bridge_delivery_latency_seconds_avg{route}`, and
`bridge_delivery_latency_seconds_max{route}`. These are gauges, not a real
histogram, because metrics are still hand-rendered text in the bot process;
they show the last in-process sample window and reset on restart.

Scrape auth: `/metrics` accepts `Authorization: Bearer <MONITORING_TOKEN>` (what
Prometheus uses) or `?token=<MONITORING_TOKEN>` (handy for `curl`). The same
token gates `/admin` unless it is unset, in which case the bot generates a
per-run token and logs how to pin one.

### The `/admin` page, section by section

Server-rendered, no build step, read-only — `/admin.json` mirrors the same
data for scripting. Four community-operations sections plus the original
usage/cost tables:

- **Overview** — platform, instance id, version, connection state, uptime,
  and message freshness.
- **Memory — your community's lore** — browse stored facts (id, text,
  category, source tag, shared status), newest 100 with a total count so you
  know if there's more.
- **Bridges** — configured routes, outbox depth and oldest-pending age,
  dead-letter count, and summary-buffer sizes; reads "bridging is not
  enabled" plainly when it isn't.
- **Health** — inline AI provider mix, memory-watchdog RSS vs. thresholds,
  and bridge failure counts, with a link to `/metrics` for full history.

The `/admin` page itself stays read-only in v3.4.0. A separate opt-in memory
write API (`ADMIN_WRITE_ENABLED`, default off) adds authenticated delete,
share, and unshare endpoints with confirmation nonces and an audit log;
broader edit and import endpoints remain planned for a later release.

## HTTP Health-Check Monitors

Use any HTTP health-check monitor for paging and Grafana for diagnosis.
Recommended monitors:

| Monitor | URL | Trigger |
|---|---|---|
| HTTP | `http://<host>:${DISCORD_HEALTH_PORT:-3002}/health` | non-200 -> Discord health server unhealthy |
| HTTP | `http://<host>:${WHATSAPP_HEALTH_PORT:-3001}/health/ready` | non-200 -> WhatsApp disconnected |
| HTTP | `http://<host>:${TELEGRAM_HEALTH_PORT:-3005}/health/ready` | non-200 -> Telegram polling disconnected |
| HTTP | `http://<host>:${MATRIX_HEALTH_PORT:-3004}/health/ready` | non-200 -> Matrix sync unhealthy |
| Keyword | `http://<host>:${WHATSAPP_HEALTH_PORT:-3001}/health`, keyword `"integrityOk":true` | nightly backup went bad |
| Keyword | `http://<host>:${WHATSAPP_HEALTH_PORT:-3001}/health`, keyword `"paused":false` | anti-ban layer paused sends |

`/health/ready` reflects adapter connection state only for adapters that wire
the shared health state. In this tree that is WhatsApp and Telegram. Discord
serves `/health`, but it does not currently mark gateway connection state for
`/health/ready`.

## Grafana alerting (optional)

If you alert from Grafana, the highest-value rules are:
`garbanzo_connection_status{status="connected"} == 0` for 2m,
`garbanzo_backup_integrity_ok == 0`, `garbanzo_daily_cost_usd > 1`,
`garbanzo_whatsapp_safety_paused == 1`, and
`increase(garbanzo_reconnect_count[1h]) > 5`.
