# Configuration

## Environment Variables

Garbanzo uses layered env files.

- `.env` is the shared layer: compose profiles, AI provider keys, monitoring,
  vector memory, metadata, persistence, and common integrations.
- `.env.discord` is the Discord instance layer: Discord app tokens, channel
  bindings, band-mode settings, and optional Discord-specific overrides.
- `.env.whatsapp` is the WhatsApp instance layer: owner JID, browser login, bot
  phone number, outbound safety, and WhatsApp event-reminder settings.

Docker Compose loads files in this order for each bot service:
`.env`, then `.env.discord` or `.env.whatsapp`. Later files override earlier
files. Native runs use the same layering through the config loader's
`applyEnvLayers`, so `npm run dev` and `npm run start` read the same split
layout. Empty optional values such as `QDRANT_API_KEY=` are treated as unset.

Copy `.env.example` to `.env`, then copy the platform example for every profile
you enable:

```bash
cp .env.example .env
cp .env.discord.example .env.discord
# Optional WhatsApp instance:
# cp .env.whatsapp.example .env.whatsapp
```

| Variable | Required | Purpose |
|----------|----------|---------|
| `COMPOSE_PROFILES` | Docker | Compose profile list, for example `discord`, `whatsapp`, or `discord,whatsapp,monitoring` |
| `MESSAGING_PLATFORM` | No | Messaging runtime target (`discord`, `whatsapp`, `slack`, `telegram`, `matrix`); defaults to `discord` and is pinned per bot service in `docker-compose.yml` |
| `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` or `OPENAI_API_KEY` or `GEMINI_API_KEY` or `BEDROCK_MODEL_ID` | Yes | Cloud AI responses (Claude/OpenAI/Gemini/Bedrock failover) |
| `AI_PROVIDER_ORDER` | No | Comma-separated cloud provider priority (default: `openai,anthropic`) |
| `ANTHROPIC_MODEL` | No | Anthropic model override (default: `claude-haiku-4-5-20251001`) |
| `ANTHROPIC_PRICING_INPUT_PER_M` | No | Anthropic input pricing (USD per 1M tokens, for cost tracking; default `1.0` = Haiku 4.5) |
| `ANTHROPIC_PRICING_OUTPUT_PER_M` | No | Anthropic output pricing (USD per 1M tokens; default `5.0` = Haiku 4.5) |
| `ANTHROPIC_PROMPT_CACHING` | No | Mark the static persona system prompt cacheable so repeat calls read it at ~10% input price (default: `true`) |
| `OPENROUTER_MODEL` | No | OpenRouter model override (default: `anthropic/claude-sonnet-4-5`) |
| `OPENAI_MODEL` | No | OpenAI model override (default: `gpt-5.4-mini`; oauth mode uses a ChatGPT-backend slug) |
| `OPENAI_REASONING_EFFORT` | No | GPT-5/o-series reasoning depth on chat replies: `minimal`/`low`/`medium`/`high` (default: `low`; bounds hidden reasoning-token spend) |
| `OPENAI_PRICING_INPUT_PER_M` | No | OpenAI input pricing (USD per 1M tokens; default `0.75` = gpt-5.4-mini) |
| `OPENAI_PRICING_OUTPUT_PER_M` | No | OpenAI output pricing (USD per 1M tokens; default `4.5` = gpt-5.4-mini) |
| `OPENAI_AUTH_MODE` | No | `apikey` (default) or `oauth` ("Sign in with ChatGPT", experimental — see below) |
| `AI_TOOL_CALLING` | No | Enable native LLM tool calling for OpenRouter, Anthropic, and OpenAI API-key mode (default: `false`) |
| `AI_TOOL_MAX_ITERATIONS` | No | Max tool-call rounds per response, 1-5 (default: `3`) |
| `GEMINI_MODEL` | No | Gemini model override (default: `gemini-1.5-flash`) |
| `GEMINI_PRICING_INPUT_PER_M` | No | Gemini input pricing (USD per 1M tokens, for cost tracking) |
| `GEMINI_PRICING_OUTPUT_PER_M` | No | Gemini output pricing (USD per 1M tokens, for cost tracking) |
| `BEDROCK_REGION` | Bedrock only | AWS region for Bedrock runtime (default: `us-east-1`) |
| `BEDROCK_MODEL_ID` | Bedrock only | Bedrock model ID used when provider order includes `bedrock` |
| `BEDROCK_MAX_TOKENS` | Bedrock only | Max output tokens for Bedrock calls (default: `1024`) |
| `BEDROCK_PRICING_INPUT_PER_M` | Bedrock only | Bedrock input pricing (USD per 1M tokens, for cost tracking) |
| `BEDROCK_PRICING_OUTPUT_PER_M` | Bedrock only | Bedrock output pricing (USD per 1M tokens, for cost tracking) |
| `GOOGLE_API_KEY` | No | Weather + venue search |
| `MBTA_API_KEY` | No | Transit data (Boston-specific) |
| `NEWSAPI_KEY` | No | News search |
| `FIRECRAWL_API_KEY` | No | Firecrawl search + page extraction — top-priority web_search provider |
| `BRAVE_SEARCH_API_KEY` | No | Brave Search API — powers the web_search AI tool (default when Firecrawl is not configured) |
| `GOOGLE_SEARCH_ENGINE_ID` | No | Google Programmable Search engine ID for the web_search AI tool |
| `SEARXNG_BASE_URL` | No | Operator-run SearXNG base URL for the web_search AI tool |
| `WEB_SEARCH_PROVIDER` | No | Optional web_search provider override: `firecrawl`, `brave`, `google`, or `searxng` |
| `SLACK_BOT_TOKEN` | Slack only | Official Slack bot token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack only | Slack Events API signing secret (Basic Information -> App Credentials) |
| `SLACK_BOT_USER_ID` | Optional | Bot user id for mention matching (`U...`) |
| `SLACK_CLIENT_ID` | Slack rotation | Required for token refresh flow |
| `SLACK_CLIENT_SECRET` | Slack rotation | Required for token refresh flow |
| `SLACK_REFRESH_TOKEN` | Slack rotation | Rotating refresh token from OAuth response |
| `SLACK_TOKEN_STATE_FILE` | Optional | Local persisted token state path (default `data/slack-token-state.json`) |
| `SLACK_TOKEN_ROTATE_MIN_BUFFER` | Optional | Minutes before expiry to refresh (default `5`) |
| `DISCORD_BOT_TOKEN` | Discord only | Official Discord bot token |
| `DISCORD_PUBLIC_KEY` | Discord only | Discord interactions signature public key |
| `DISCORD_OWNER_ID` | Discord only | Discord owner user ID for escalation and owner commands |
| `DISCORD_GATEWAY_ENABLED` | Discord only | Enable Discord Gateway runtime (default: `true`) |
| `DISCORD_CHANNELS_CONFIG_PATH` | Discord only | Channel/role config path (default: `config/discord-channels.json`) |
| `OLLAMA_BASE_URL` | No | Local model inference (default: `http://127.0.0.1:11434`) |
| `DB_DIALECT` | No | Database backend: `sqlite` (default) or `postgres` |
| `DATABASE_URL` | Postgres only | Full Postgres connection string (alternative to individual `POSTGRES_*` vars) |
| `POSTGRES_HOST` | Postgres only | Postgres hostname |
| `POSTGRES_PORT` | Postgres only | Postgres port (default: `5432`) |
| `POSTGRES_DB` | Postgres only | Postgres database name |
| `POSTGRES_USER` | Postgres only | Postgres user |
| `POSTGRES_PASSWORD` | Postgres only | Postgres password |
| `POSTGRES_SSL` | Postgres only | Enable SSL for Postgres connection (default: `false`) |
| `POSTGRES_SSL_REJECT_UNAUTHORIZED` | Postgres only | Reject unauthorized SSL certs (default: `false`) |
| `CONTEXT_SESSION_MEMORY_ENABLED` | No | Enable session memory pipeline (default: `true`) |
| `CONTEXT_SESSION_GAP_MINUTES` | No | Inactivity gap to close a session (default: `30`) |
| `CONTEXT_SESSION_MIN_MESSAGES` | No | Minimum messages to summarize a session (default: `4`) |
| `CONTEXT_SESSION_MAX_RETRIEVED` | No | Max session summaries injected into prompt context (default: `3`) |
| `CONTEXT_SESSION_SUMMARY_VERSION` | No | Summary algorithm version for cache invalidation (default: `1`) |
| `MEMORY_AUTO_EXTRACT` | No | Enable automatic long-term community fact extraction (default: `false`) |
| `MEMORY_AUTO_EXTRACT_MIN_MESSAGES` | No | Per-group messages required between extraction attempts (default: `25`) |
| `MEMORY_AUTO_EXTRACT_INTERVAL_MINUTES` | No | Minimum minutes between extraction attempts per group (default: `360`) |
| `MEMORY_AUTO_MAX_FACTS` | No | Max retained auto-extracted facts (default: `200`) |
| `VECTOR_STORE` | No | Vector backend: `qdrant` (default) or `none` (keyword-only, no embeddings) |
| `QDRANT_URL` | No | Qdrant server URL. Compose uses `http://qdrant:${QDRANT_PORT:-6333}` for bot services. |
| `QDRANT_API_KEY` | No | Qdrant API key, if the server requires one |
| `QDRANT_COLLECTION` | No | Local Qdrant collection for this instance's own facts. Default is `garbanzo_memory`, unless `INSTANCE_ID` is set and this is left unset, in which case it defaults to `garbanzo_memory_<INSTANCE_ID>` so two instances on the same Qdrant deployment don't silently share facts. An explicit value always wins. See [docs/BRIDGING.md](BRIDGING.md) for the multi-instance isolation rule. |
| `VECTOR_EMBEDDING_PROVIDER` | No | Embedding provider: `openai` (default) or `deterministic` |
| `VECTOR_EMBEDDING_MODEL` | No | OpenAI embedding model (default: `text-embedding-3-small`) |
| `VECTOR_EMBEDDING_TIMEOUT_MS` | No | Embedding API timeout in ms (default: `12000`) |
| `VECTOR_EMBEDDING_MAX_CHARS` | No | Max input chars for embedding (default: `4000`) |
| `OLLAMA_MODEL` | No | Local Ollama model for simple queries (default: `qwen3:8b`; use a 1-3B model on Pi-class hosts) |
| `HEALTH_PORT` | No | Health endpoint port. Compose sets this from the platform placeholder, such as `${WHATSAPP_HEALTH_PORT:-3001}` for WhatsApp. |
| `HEALTH_BIND_HOST` | No | Health bind host (`127.0.0.1` default, use `0.0.0.0` for external monitors) |
| `METRICS_ENABLED` | No | Enable Prometheus `/metrics` scraping on the health server (default: `false`), including expanded community/admin metric families; token auth accepts either `?token=` or `Authorization: Bearer`. |
| `MONITORING_TOKEN` | Monitoring/admin | Token for `/metrics`, `/admin`, Prometheus scrapes, and Grafana admin password fallback |
| `GRAFANA_ADMIN_PASSWORD` | Monitoring only | Optional Grafana admin password override; defaults to `MONITORING_TOKEN` when unset |
| `WHATSAPP_LOGIN_MODE` | No | WhatsApp linking UI: `web` (default, browser page), `terminal` (in-terminal QR), or `both` |
| `WHATSAPP_LOGIN_TOKEN` | WhatsApp only | Pin the WhatsApp browser-login token instead of generating one per run; it only guards `/whatsapp/login*` |
| `WHATSAPP_CHAT_SCOPE` | No | WhatsApp inbound scope: `all` (default) ingests every delivered chat; `configured` ingests only enabled groups from `config/groups.json`, while DMs still flow |
| `WHATSAPP_SET_PROFILE_NAME` | No | Set the WhatsApp account profile name on connect (default: `true`); set `false` on secondary linked-device instances sharing one account |
| `ADMIN_PAGE_ENABLED` | No | Owner admin page at `/admin` + `/admin.json` on the health port (default: `true`; only served when a token exists) |
| `EVENT_REMINDERS_ENABLED` | No | Enable Events-group reminder capture and scheduled reminder sends (default: `true`) |
| `EVENT_REMINDER_LEAD_MINUTES` | No | Minutes before a parsed event start time to post a reminder (default: `120`) |
| `APP_VERSION` | No | Version marker used for Docker image labels + release note headers |
| `OWNER_JID` | WhatsApp only | Owner WhatsApp JID; required only when `MESSAGING_PLATFORM=whatsapp` |
| `TELEGRAM_BOT_TOKEN` | Telegram only | Bot token from @BotFather; required only when `MESSAGING_PLATFORM=telegram` |
| `TELEGRAM_OWNER_ID` | Telegram only | Owner's numeric Telegram user id (from @userinfobot); required only when `MESSAGING_PLATFORM=telegram` |
| `TELEGRAM_CHATS_CONFIG_PATH` | No | Path to the Telegram chat config file (default: `config/telegram-chats.json`) |
| `TELEGRAM_CHAT_SCOPE` | No | Telegram inbound scope: `configured` (default) ingests only enabled chats from `config/telegram-chats.json`; `all` ingests every chat the bot is added to. Default differs from WhatsApp's `all` because anyone can add the bot to any group via its `@username`. DMs still flow either way |
| `MATRIX_HOMESERVER_URL` | Matrix only | Base URL of the homeserver the bot's account lives on, e.g. `https://matrix.example.org`; required only when `MESSAGING_PLATFORM=matrix` |
| `MATRIX_ACCESS_TOKEN` | Matrix only | Bot account access token (Element: Settings -> Help & About -> Advanced -> Access Token, or a scripted `/_matrix/client/v3/login`); required only when `MESSAGING_PLATFORM=matrix` |
| `MATRIX_OWNER_ID` | Matrix only | Owner's Matrix user id, e.g. `@you:example.org`, not the bot's; required only when `MESSAGING_PLATFORM=matrix` |
| `MATRIX_ROOMS_CONFIG_PATH` | No | Path to the Matrix room config file (default: `config/matrix-rooms.json`) |
| `MATRIX_CHAT_SCOPE` | No | Matrix inbound scope: `configured` (default) ingests only enabled rooms from `config/matrix-rooms.json`; `all` ingests every room the bot is joined to. Default differs from WhatsApp's `all` because anyone who knows the bot's Matrix user id can invite it to a room, the same rationale as `TELEGRAM_CHAT_SCOPE`. DMs still flow either way |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) |
| `INSTANCE_ID` | No | Deployment identity for cross-instance bridging; defaults to `MESSAGING_PLATFORM` |
| `BRIDGE_ENABLED` | No | Master switch for cross-platform message bridging (default: `false`) |
| `BRIDGE_TRANSPORT` | No | Bridge delivery transport: `http` (default) or `amqp` |
| `BRIDGE_BROKER_URL` | Bridge (amqp) | AMQP broker URL, for example `amqp://garbanzo:<password>@rabbitmq:5672`; required when `BRIDGE_TRANSPORT=amqp` |
| `BRIDGE_BROKER_USER` | Bridge (amqp, broker profile) | Compose-only interpolation var — RabbitMQ user for the `broker` profile's `rabbitmq` container (default: `garbanzo`). Not read by the bot process itself; only referenced via `${BRIDGE_BROKER_USER}` in `docker-compose*.yml`. |
| `BRIDGE_BROKER_PASSWORD` | Bridge (amqp, broker profile) | Compose-only interpolation var — RabbitMQ password for the `broker` profile's `rabbitmq` container; the container refuses to start without it. Not read by the bot process itself; only referenced via `${BRIDGE_BROKER_PASSWORD}` in `docker-compose*.yml`. |
| `BRIDGE_SUMMARY_INTERVAL_MINUTES` | No | Minutes between WhatsApp-bound bridge digest flushes (default: `15`) |
| `BRIDGE_MAX_TEXT` | No | Max characters per relayed/digest bridge message (default: `1500`) |
| `BRIDGE_MEDIA_ENABLED` | No | Sending-instance opt-in for bridged media re-upload (default: `false`); the route must also set `mediaRelay: true` |
| `BRIDGE_MEDIA_MAX_BYTES` | No | Maximum decoded bridged-media payload size (default: `8388608` bytes / 8 MiB); values clamp to `65536`-`20971520` bytes |
| `SHARED_MEMORY_ENABLED` | No | Master switch for explicit cross-instance shared memory (`!memory share`/`unshare`) (default: `false`) |
| `QDRANT_SHARED_COLLECTION` | No | Qdrant collection used for shared community facts (default: `garbanzo_shared`) |

Docker Compose sets `QDRANT_URL=http://qdrant:${QDRANT_PORT:-6333}` explicitly for bot services on the compose network.

Full bridging setup, including the bridge-map schema and a worked multi-instance example: [docs/BRIDGING.md](BRIDGING.md).

## RAG federation

| Variable | Required | Purpose |
|----------|----------|---------|
| `RAG_FEDERATION_ENABLED` | No | Enable read-only prompt-time search across sources listed in `config/rag-sources.json` (default: `false`) |

Source definitions live in `config/rag-sources.json`; start from `config/rag-sources.example.json`. Each source declares its Qdrant collection, text payload field, embedding provider/model/dimensions, optional chat allowlist, and per-source score/hit limits. See [docs/RAG_FEDERATION.md](RAG_FEDERATION.md).

Features degrade gracefully when API keys are missing — the bot won't crash, it just skips that feature.

## Setup Wizard

Run `npm run setup` for an interactive setup. The wizard leads with Discord,
then writes the shared `.env` plus the env file for the platform you selected
(`.env.discord` or `.env.whatsapp`). To run both platforms, run the wizard
once per platform or copy the other example file by hand. Shared provider,
monitoring, vector, and integration values stay in `.env`; platform-only
values stay in the platform layer.

## Owner admin page

`http://<host>:${DISCORD_HEALTH_PORT:-3002}/admin?token=<MONITORING_TOKEN>` on Discord or
`http://<host>:${WHATSAPP_HEALTH_PORT:-3001}/admin?token=<MONITORING_TOKEN>` on WhatsApp renders a token-gated,
auto-refreshing snapshot of today's usage: AI spend vs. the $1 alert threshold,
per-provider calls/tokens/cost, per-group activity (messages, active users, bot
replies, moderation flags, AI errors), and the WhatsApp outbound-safety
counters. `/admin.json` returns the same data raw for scripting. The page is
never served without a token, and requests share the health endpoint's rate
limit. Disable with `ADMIN_PAGE_ENABLED=false`.

## Automatic community memory

`MEMORY_AUTO_EXTRACT=false` by default. When enabled, Garbanzo periodically scans
recent group context after a successful group AI response and asks the configured
AI provider to extract 0-3 durable community facts: recurring events, venues,
member roles/projects, traditions, or general long-term facts.

The extractor is gated per group by `MEMORY_AUTO_EXTRACT_MIN_MESSAGES` and
`MEMORY_AUTO_EXTRACT_INTERVAL_MINUTES`, so it adds at most one extra cheap LLM
call per group per interval. Auto-extracted facts are stored with source `auto`,
included in the same prompt memory as owner-added facts, capped by
`MEMORY_AUTO_MAX_FACTS`, and visible in `!memory` with an `(auto)` tag. Curate
them with the existing owner command: `!memory delete <id>`.

## WhatsApp outbound safety (anti-ban)

| Variable | Default | Purpose |
|----------|---------|---------|
| `WHATSAPP_SAFETY_ENABLED` | `true` | Enables the outbound safety layer for WhatsApp sends. |
| `WHATSAPP_SAFETY_MAX_PER_MINUTE` | `5` | Per-minute outbound rate cap. |
| `WHATSAPP_SAFETY_MAX_PER_HOUR` | `100` | Per-hour outbound rate cap. |
| `WHATSAPP_SAFETY_MAX_PER_DAY` | `2000` | Per-day outbound rate cap. |
| `WHATSAPP_SAFETY_MIN_DELAY_MS` | `2500` | Minimum inter-message delay in milliseconds. |
| `WHATSAPP_SAFETY_MAX_DELAY_MS` | `7000` | Maximum inter-message delay in milliseconds. |
| `WHATSAPP_SAFETY_WARMUP_DAYS` | `10` | Number of days a newly linked account follows the warm-up ramp. |
| `WHATSAPP_SAFETY_DAY1_LIMIT` | `2000` | First-day warm-up cap before ramp growth is applied. |
| `WHATSAPP_SAFETY_AUTO_PAUSE_AT` | `medium` | Risk level that automatically pauses outbound WhatsApp sends. |

Two independent gates can stop outbound WhatsApp sends. The warm-up ramp starts
at `WHATSAPP_SAFETY_DAY1_LIMIT` and grows by `day1Limit * growthFactor^day`,
then graduates to unlimited after `WHATSAPP_SAFETY_WARMUP_DAYS`. The rate
limiter separately enforces the per-minute, per-hour, and per-day caps plus the
minimum/maximum inter-message delay. The effective daily cap is the lower of the
warm-up ramp and `WHATSAPP_SAFETY_MAX_PER_DAY`. `WHATSAPP_SAFETY_AUTO_PAUSE_AT`
auto-pauses outbound sends when risk reaches the configured level.

Loosening or disabling for testing: set `WHATSAPP_SAFETY_WARMUP_DAYS=0` to skip
the warm-up ramp, raise the rate caps for a higher test ceiling, or set
`WHATSAPP_SAFETY_ENABLED=false` to turn off rate limits, warm-up, and auto-pause.
Only disable the full safety layer on an established number.

## Event Reminders

Event reminders are captured only from passively detected proposals in the
configured Events group. `EVENT_REMINDERS_ENABLED` controls both capture and the
WhatsApp scheduler. `EVENT_REMINDER_LEAD_MINUTES` sets how early the reminder is
posted before the parsed event start time.

## AI Routing Profiles (Examples)

Cost-optimized routing (fast + affordable cloud-first):

```bash
AI_PROVIDER_ORDER=gemini,openrouter,openai,anthropic
GEMINI_MODEL=gemini-1.5-flash
OPENROUTER_MODEL=anthropic/claude-sonnet-4-5
```

Quality-prioritized routing (high-complexity prompts first):

```bash
AI_PROVIDER_ORDER=anthropic,openai,gemini,openrouter
ANTHROPIC_MODEL=claude-sonnet-5
OPENAI_MODEL=gpt-5.4
```

Hybrid local/cloud routing (keep simple prompts local):

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
AI_PROVIDER_ORDER=openrouter,gemini,openai
```

## Native LLM Tool Calling

`AI_TOOL_CALLING=false` by default. When enabled, OpenRouter, Anthropic, and
OpenAI API-key mode can call configured Garbanzo integrations while drafting a
reply. That lets a member ask `@garbanzo is the L running?` and get live transit
data without needing `!transit`.

Available tools mirror existing feature handlers: weather and venue search need
`GOOGLE_API_KEY`, transit needs `MBTA_API_KEY`, news needs `NEWSAPI_KEY`, and
book lookup plus community memory search are available without extra API keys.
`AI_TOOL_MAX_ITERATIONS` limits tool-call rounds per model response from 1 to 5.

## Group Configuration

Edit `config/groups.json` to map your WhatsApp group IDs:

```json
{
  "groups": {
    "YOUR_GROUP_JID@g.us": {
      "name": "General",
      "enabled": true,
      "requireMention": true,
      "persona": "Casual and conversational.",
      "enabledFeatures": ["weather", "transit", "fun"]
    }
  },
  "mentionPatterns": ["@yourbot", "@YourBot"],
  "admins": {
    "owner": {
      "name": "Your Name",
      "jid": "1YOURNUMBER@s.whatsapp.net"
    }
  }
}
```

To find your group JIDs, enable `LOG_LEVEL=debug` and check logs when messages arrive.

**Per-group options:**
- `enabled` — whether the bot responds in this group
- `requireMention` — if true, bot only responds to @mentions (recommended)
- `persona` — custom personality hint for this group (injected into Claude prompt)
- `enabledFeatures` — array of feature names to enable (omit for all features)

> **Docker:** `docker-compose.yml` bind-mounts the host `./config/groups.json`
> read-only into the container, so your edits take effect on `docker compose
> restart` with **no image rebuild**. The file must exist on the host (the setup
> wizard creates it) before `docker compose up`, or Docker will create a directory
> in its place and the bot will fail to start.

## OpenAI OAuth (experimental)

OpenAI supports two auth modes via `OPENAI_AUTH_MODE`:

- **`apikey` (default):** standard `OPENAI_API_KEY` against `api.openai.com`. Recommended.
- **`oauth` (experimental):** use a ChatGPT (Plus/Pro) subscription instead of an API key.

  ```bash
  npm run openai:login   # opens the browser, links your ChatGPT account
  # then set OPENAI_AUTH_MODE=oauth and include "openai" in AI_PROVIDER_ORDER
  ```

  **Headless / remote host (e.g. a Raspberry Pi over SSH).** OpenAI pins the OAuth
  redirect to `http://localhost:1455`, so on a machine with no local browser, run:

  ```bash
  npm run openai:login -- --manual   # or: node scripts/openai-login.mjs --manual
  ```

  It prints the sign-in URL — open it in a browser on any machine, authorize, then
  the browser lands on a dead `localhost:1455/...` page. Copy that URL (or just the
  `code`) back into the terminal prompt. No `ssh -L` tunnel required. (The default
  `npm run openai:login` also falls back to this paste prompt if the callback never
  arrives.) In Docker, the login script isn't in the image — run it on the host to
  write `data/openai-oauth.json`, then load it into the container's volume:
  `docker compose cp data/openai-oauth.json discord:/app/data/openai-oauth.json`
  and `docker compose exec -u root discord chown garbanzo:garbanzo /app/data/openai-oauth.json`
  for the Discord service. Use `whatsapp` instead of `discord` for a WhatsApp
  instance.

  > ⚠️ **Unofficial and against OpenAI's Terms of Service.** It reuses the Codex
  > OAuth client to call OpenAI's private ChatGPT backend (SSE streaming) and
  > can break without notice. Verified end-to-end against a live token on
  > 2026-07-02. It is isolated and always falls
  > back to the next provider in `AI_PROVIDER_ORDER` on any failure — never make
  > it your only provider. Tokens are stored in `data/openai-oauth.json`
  > (gitignored, mode `0600`). In oauth mode `OPENAI_MODEL` must be a
  > ChatGPT-backend model slug, not an API model name.

## Troubleshooting: Qdrant on Raspberry Pi 5 (and other 16 KB-page hosts)

**Symptom — Qdrant crash-loops on startup:**

```
<jemalloc>: Unsupported system page size
memory allocation of 144 bytes failed
Aborted (core dumped)
```

Qdrant's binary bundles jemalloc built for 4 KB memory pages. Some arm64
hosts run a **16 KB-page kernel** — including the Raspberry Pi 5 default
(`kernel_2712.img`) — and jemalloc aborts immediately. This is not a config
or storage problem: do not delete the Qdrant data volume, and version-pinning
the image does not help (every official Qdrant arm64 image has the same
jemalloc).

Fix — switch to a 4 KB-page kernel. On Raspberry Pi OS, add this line under
`[all]` in `/boot/firmware/config.txt`, then reboot:

```
kernel=kernel8.img
```

Confirm with `getconf PAGESIZE` (should print `4096`). The same page-size
requirement affects other jemalloc-based services (MongoDB, etc.). If you
would rather not change the kernel, set `VECTOR_STORE=none` — the bot runs
normally on keyword-only memory, but loses semantic recall.

**Symptom — `ERROR qdrant: Error while starting gRPC server: transport error`:**

Harmless. The bot talks to Qdrant over the REST/HTTP API, never gRPC. This
appears when `QDRANT_PORT` is set to `6334`, which is Qdrant's fixed gRPC
port, so its HTTP server takes 6334 and gRPC cannot bind. Set `QDRANT_PORT`
to any other value (the default `6333` is fine; Qdrant is not published to
the host, so it rarely needs changing).

**Confirming Qdrant is healthy from the bot's side:** a working setup logs
`Created Qdrant collection` on first run and never logs
`Qdrant ensureCollection failed; vector memory degraded`. The per-instance
collection is `garbanzo_memory_<INSTANCE_ID>` unless `QDRANT_COLLECTION` is
set (see the `QDRANT_COLLECTION` row above).
